import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthedUser } from '../auth/current-user.decorator';
import { ShareService } from './share.service';

/** Rider or driver creates a live-tracking link for their current trip. */
@Controller('rides')
@UseGuards(JwtAuthGuard)
export class ShareController {
  constructor(private readonly share: ShareService) {}

  @Post(':id/share')
  create(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.share.create(id, user.id);
  }
}

/**
 * Public view behind a share link. No account: the token is the key. Polled
 * every few seconds by the tracking page, so it sits in the default bucket.
 */
@Controller('share')
export class PublicShareController {
  constructor(private readonly share: ShareService) {}

  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Get(':token')
  view(@Param('token') token: string) {
    return this.share.view(token);
  }
}
