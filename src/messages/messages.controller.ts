import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, Length } from 'class-validator';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthedUser } from '../auth/current-user.decorator';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { MessagesService } from './messages.service';

class SendDto {
  @IsString() @Length(1, 500) body: string;
}

@Controller('rides/:rideId')
@UseGuards(JwtAuthGuard)
export class MessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly gateway: RealtimeGateway,
  ) {}

  @Get('messages')
  list(
    @CurrentUser() user: AuthedUser,
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Query('after') after?: string,
  ) {
    return this.messages.list(rideId, user.id, after);
  }

  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  @Post('messages')
  async send(
    @CurrentUser() user: AuthedUser,
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body() dto: SendDto,
  ) {
    const m = await this.messages.send(rideId, user.id, dto.body);
    // Live delivery to the two people on the trip (each is in their own room).
    const payload = { rideId, id: m.id, senderId: user.id, body: m.body, at: m.at };
    this.gateway.server.to(`user:${user.id}`).emit('ride:message', payload);
    if (m.recipientId) this.gateway.server.to(`user:${m.recipientId}`).emit('ride:message', payload);
    return { id: m.id, at: m.at };
  }

  /** Name of the other person, for the chat header. No phone number. */
  @Get('counterpart')
  counterpart(@CurrentUser() user: AuthedUser, @Param('rideId', ParseUUIDPipe) rideId: string) {
    return this.messages.counterpart(rideId, user.id);
  }

  @Get('call-config')
  async callConfig(@CurrentUser() user: AuthedUser, @Param('rideId', ParseUUIDPipe) rideId: string) {
    await this.messages.counterpart(rideId, user.id); // participant check
    return { iceServers: this.messages.iceServers() };
  }
}
