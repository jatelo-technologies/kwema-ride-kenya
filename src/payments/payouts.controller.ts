import { Body, Controller, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsIn } from 'class-validator';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthedUser } from '../auth/current-user.decorator';
import { PayoutsService } from './payouts.service';

class SendDto {
  @IsIn(['mpesa', 'mtnmomo', 'airtelmoney']) wallet: 'mpesa' | 'mtnmomo' | 'airtelmoney';
}

/** Admin only: moves real money. */
@Controller('admin/payouts')
@UseGuards(JwtAuthGuard)
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  private assertAdmin(user: AuthedUser) {
    if (user.role !== 'admin') throw new ForbiddenException('admin only');
  }

  @Get('open')
  open(@CurrentUser() user: AuthedUser) {
    this.assertAdmin(user);
    return this.payouts.open();
  }

  @Post(':id/send')
  send(@CurrentUser() user: AuthedUser, @Param('id') id: string, @Body() dto: SendDto) {
    this.assertAdmin(user);
    return this.payouts.send(id, dto.wallet);
  }

  @Post(':id/refresh')
  refresh(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    this.assertAdmin(user);
    return this.payouts.refresh(id);
  }
}
