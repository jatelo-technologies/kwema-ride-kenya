import { Body, Controller, Delete, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsString, Length } from 'class-validator';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthedUser } from '../auth/current-user.decorator';
import { NotificationsService } from './notifications.service';

class RegisterDto {
  @IsString() @Length(20, 4096) token: string;
  @IsIn(['android', 'ios']) platform: 'android' | 'ios';
  @IsIn(['rider', 'driver']) app: 'rider' | 'driver';
}

class TokenDto {
  @IsString() @Length(20, 4096) token: string;
}

@Controller('devices')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post()
  register(@CurrentUser() user: AuthedUser, @Body() dto: RegisterDto) {
    return this.notifications.register(user.id, dto.token, dto.platform, dto.app);
  }

  @Delete()
  unregister(@CurrentUser() user: AuthedUser, @Body() dto: TokenDto) {
    return this.notifications.unregister(user.id, dto.token);
  }
}
