/**
 * PaymentsController + PaymentsService
 *
 * Flow
 *   1. Rider confirms payment → POST /payments/collect
 *      We create a `pending` transaction row *before* calling the aggregator.
 *      If the process dies mid-call, reconciliation still finds the intent.
 *   2. Aggregator pushes a USSD/STK prompt to the customer's handset.
 *   3. Customer enters their PIN. Aggregator calls our webhook.
 *   4. Webhook verifies the signature, applies the result idempotently,
 *      settles the ride, and emits over WebSocket to both apps.
 *   5. A reconciliation job sweeps anything still `processing` after 3
 *      minutes and queries the aggregator directly — callbacks do get lost.
 *
 * The webhook is the source of truth, never the HTTP response to step 1.
 * On a mobile-money network the customer routinely takes 40+ seconds to find
 * their PIN, so the synchronous call tells you only that the push was
 * accepted.
 */

import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  Put,
  Query,
  Get,
  Req,
  UseGuards,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { Mno, PROVIDER_SLUGS } from './mobile-money.providers';
import { PaymentsService } from './payments.service';
import { CashService } from './cash.service';
import { PHONE_EXAMPLE, isValidPhone, country } from '../common/country';

interface CollectDto {
  rideId: string;
  mno: Mno;
  /** Optional: defaults to the account phone. Lets a rider pay from another line. */
  payerPhone?: string;
}

@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly payments: PaymentsService,
    private readonly cash: CashService,
  ) {}

  // -------------------------------------------------------------------
  // Rider-initiated collection
  // -------------------------------------------------------------------
  @UseGuards(JwtAuthGuard)
  // A payment prompt is disruptive; 5 attempts per minute per user is
  // already generous and stops a buggy client from spamming a handset.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('collect')
  async collect(@CurrentUser() user: { id: string; phone: string }, @Body() dto: CollectDto) {
    if (!dto.rideId || !dto.mno) throw new BadRequestException('rideId and mno are required');

    if (!country.mobileNetworks.includes(dto.mno)) {
      throw new BadRequestException(`${dto.mno} is not available in ${country.name}`);
    }
    const phone = dto.payerPhone ?? user.phone;
    if (!isValidPhone(phone)) {
      throw new BadRequestException(`phone must be ${PHONE_EXAMPLE}`);
    }

    return this.payments.initiateCollection(user.id, dto.rideId, dto.mno, phone);
  }

  // -------------------------------------------------------------------
  // Card
  // -------------------------------------------------------------------

  /**
   * Starts a card payment and returns a hosted checkout URL for the app to
   * open in a WebView. We never accept card fields ourselves — doing so would
   * pull the whole platform into PCI DSS SAQ-D.
   */
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('card/initiate')
  initiateCard(
    @CurrentUser() user: { id: string; phone: string },
    @Body() dto: { rideId: string },
  ) {
    if (!dto?.rideId) throw new BadRequestException('rideId is required');
    return this.payments.initiateCardPayment(user.id, dto.rideId, user.phone);
  }

  /**
   * Called by the app once the WebView hits our redirect URL. The redirect is
   * only a prompt: the outcome is confirmed with the provider server-side.
   */
  @UseGuards(JwtAuthGuard)
  @Post('card/verify')
  verifyCard(
    @CurrentUser() user: { id: string },
    @Body() dto: { reference: string },
  ) {
    if (!dto?.reference) throw new BadRequestException('reference is required');
    return this.payments.verifyCardPayment(user.id, dto.reference);
  }

  // -------------------------------------------------------------------
  // Cash
  // -------------------------------------------------------------------

  /**
   * Driver confirms they were handed the cash. Commission is only booked
   * against their wallet at this point — never automatically on completion,
   * because a rider who leaves without paying is a real occurrence.
   */
  @UseGuards(JwtAuthGuard)
  @Post('cash/confirm')
  confirmCash(
    @CurrentUser() user: { id: string; driverId?: string },
    @Body() dto: { rideId: string },
  ) {
    if (!user.driverId) throw new ForbiddenException('drivers only');
    if (!dto?.rideId) throw new BadRequestException('rideId is required');
    return this.cash.confirmCollection(dto.rideId, user.driverId);
  }

  /** Driver's current cash-commission debt position. */
  @UseGuards(JwtAuthGuard)
  @Get('cash/balance')
  cashBalance(@CurrentUser() user: { id: string; driverId?: string }) {
    if (!user.driverId) throw new ForbiddenException('drivers only');
    return this.cash.debtStatus(user.driverId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('status/:reference')
  async status(@CurrentUser() user: { id: string }, @Param('reference') reference: string) {
    return this.payments.publicStatus(user.id, reference);
  }

  // -------------------------------------------------------------------
  // Operator callbacks
  //
  // Unauthenticated by JWT (the operators have none). M-Pesa, MTN MoMo and
  // Airtel Money do NOT sign their callbacks, so they are protected by:
  //   * a secret token inside the callback URL we register (?t=...);
  //   * never trusting the body: the service asks the operator for the real
  //     outcome before changing anything (see PaymentsService.handleWebhook);
  //   * a source-IP allowlist at ingress/WAF as a backstop;
  //   * idempotency on the payment reference.
  // Always answers 200: a non-2xx makes operators retry for hours.
  //
  // URL segments are neutral (daraja, momo, airtel): Safaricom rejects
  // callback URLs containing "mpesa". MTN delivers its callback with PUT.
  // -------------------------------------------------------------------
  private callbackHeaders(headers: Record<string, string>, query: Record<string, any>) {
    return {
      ...headers,
      'x-callback-token': typeof query?.t === 'string' ? query.t : '',
      'x-callback-ref': typeof query?.ref === 'string' ? query.ref : '',
    };
  }

  @Post('webhook/:slug')
  @HttpCode(200)
  async webhook(
    @Param('slug') slug: string,
    @Headers() headers: Record<string, string>,
    @Query() query: Record<string, any>,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    const providerName = PROVIDER_SLUGS[slug];
    if (!providerName) return { received: true };
    // rawBody is captured by the body-parser verify hook in main.ts.
    if (!req.rawBody) {
      this.logger.error('rawBody missing — check bodyParser verify hook');
      return { received: true };
    }
    await this.payments.handleWebhook(providerName, this.callbackHeaders(headers, query), req.rawBody);
    return { received: true };
  }

  /** MTN MoMo delivers its callbacks with PUT. */
  @Put('webhook/:slug')
  @HttpCode(200)
  webhookPut(
    @Param('slug') slug: string,
    @Headers() headers: Record<string, string>,
    @Query() query: Record<string, any>,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    return this.webhook(slug, headers, query, req);
  }

  /** M-Pesa B2C result. */
  @Post('payout-result/:slug')
  @HttpCode(200)
  async payoutResult(
    @Param('slug') slug: string,
    @Headers() headers: Record<string, string>,
    @Query() query: Record<string, any>,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    if (PROVIDER_SLUGS[slug] === 'mpesa' && req.rawBody) {
      await this.payments.recordPayoutResult(this.callbackHeaders(headers, query), req.rawBody);
    }
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }

  /** M-Pesa B2C queue timeout: NOT a failure, the payout may still complete. */
  @Post('payout-timeout/:slug')
  @HttpCode(200)
  payoutTimeout(@Param('slug') slug: string) {
    this.logger.warn(`payout queue timeout reported by ${slug}; waiting for result`);
    return { ResultCode: 0, ResultDesc: 'Accepted' };
  }
}
