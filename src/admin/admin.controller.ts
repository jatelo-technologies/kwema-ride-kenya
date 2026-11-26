import {
  Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards,
} from '@nestjs/common';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Min } from 'class-validator';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthedUser } from '../auth/current-user.decorator';
import { AdminService } from './admin.service';
import { PHONE_MESSAGE, PHONE_REGEX } from '../common/country';

const CATEGORIES = ['boda', 'bajaji', 'standard', 'xl', 'express',
  'e_boda', 'e_bajaji', 'e_car'];

class CreateDriverDto {
  @Matches(PHONE_REGEX, { message: PHONE_MESSAGE })
  phone: string;

  @IsString() drivingLicenceNo: string;
  @IsString() drivingLicenceExpiry: string;
  @IsOptional() @IsString() operatorLicenceNo?: string;
  @IsOptional() @IsString() operatorLicenceExpiry?: string;

  @IsString() plateNumber: string;
  @IsString() make: string;
  @IsString() model: string;
  @IsOptional() @IsString() colour?: string;
  @IsOptional() @IsInt() year?: number;
  @IsIn(CATEGORIES) category: string;
  @IsOptional() @IsInt() seats?: number;

  @IsString() insurancePolicyNo: string;
  @IsString() insuranceExpiry: string;
  @IsOptional() @IsString() homeCity?: string;
  @IsOptional() @IsString() fullName?: string;
}

class PublishTariffDto {
  @IsOptional() @IsString() zoneId?: string;
  @IsIn(CATEGORIES) category: string;
  @IsInt() @Min(0) baseFareCents: number;
  @IsInt() @Min(0) perKmCents: number;
  @IsInt() @Min(0) perMinuteCents: number;
  @IsInt() @Min(0) minimumFareCents: number;
  @IsInt() @Min(0) cancellationFeeCents: number;
  @IsInt() @Min(0) waitingPerMinuteCents: number;
  @IsInt() @Min(0) commissionBps: number;
  @IsInt() @Min(0) bookingFeeBps: number;
  @IsNumber() maxSurge: number;
  @IsString() gazetteReference: string;
}

class VerifyDriverDto {
  /** What the admin checked on NTSA (eCitizen / TIMS), e.g. a search or record reference. */
  @IsOptional() @IsString() @Length(0, 80)
  ntsaReference?: string;
}

class SuspendDto {
  @IsString() reason: string;
}

/**
 * Admin API.
 *
 * Every route is behind the role check. These expose the whole fleet's
 * financial position and can put vehicles on the road, so there is no
 * read-only tier that skips it.
 */
@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  overview(@CurrentUser() user: AuthedUser) {
    this.assertAdmin(user);
    return this.admin.overview();
  }

  @Get('drivers')
  drivers(
    @CurrentUser() user: AuthedUser,
    @Query('filter') filter?: string,
    @Query('limit') limit = '50',
  ) {
    this.assertAdmin(user);
    return this.admin.drivers(filter, Number(limit) || 50);
  }

  @Post('drivers')
  createDriver(@CurrentUser() user: AuthedUser, @Body() dto: CreateDriverDto) {
    this.assertAdmin(user);
    return this.admin.createDriver(dto);
  }

  @Post('drivers/:id/verify')
  verify(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body() dto: VerifyDriverDto,
  ) {
    this.assertAdmin(user);
    return this.admin.verifyDriver(id, user.id, dto?.ntsaReference);
  }

  @Post('drivers/:id/suspend')
  suspend(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body() dto: SuspendDto,
  ) {
    this.assertAdmin(user);
    return this.admin.suspendDriver(id, dto.reason);
  }

  @Get('rides')
  rides(
    @CurrentUser() user: AuthedUser,
    @Query('status') status?: string,
    @Query('limit') limit = '50',
    @Query('service') service?: string,
  ) {
    this.assertAdmin(user);
    return this.admin.rides(status, Number(limit) || 50, service);
  }

  @Get('tariffs')
  tariffs(@CurrentUser() user: AuthedUser) {
    this.assertAdmin(user);
    return this.admin.tariffs();
  }

  @Post('tariffs')
  publishTariff(@CurrentUser() user: AuthedUser, @Body() dto: PublishTariffDto) {
    this.assertAdmin(user);
    return this.admin.publishTariff(dto);
  }

  private assertAdmin(user: AuthedUser): void {
    if (user.role !== 'admin') throw new ForbiddenException('admin only');
  }
}
