import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { NOTIFICATION_PREFERENCES_SCHEMA, type NotificationPreferencesView, UpdateNotificationPreferencesDto } from './dto/notification-preferences.dto';
import { type NotificationPreferenceState, NotificationPreferencesService } from './notification-preferences.service';

const UNAUTHORIZED = 'Access token is missing, invalid, expired or its session was revoked (suspended or inactive accounts have no valid session).';

/**
 * P3-BE07 push preference of the authenticated user (any role). The account
 * always comes from the access token; no endpoint accepts a user id and
 * there is no administrative override.
 */
@ApiTags('Notification preferences')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('notification-preferences')
export class NotificationPreferencesController {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  @Get()
  @ApiOperation({
    summary: 'Get my push notification preference',
    description:
      'Read-only (never creates a record). Without a stored preference push is OFF: `pushEnabled: false`, `pushEnabledAt: null`, `updatedAt: null`. ' +
      '`pushAvailable` tells whether this environment currently delivers real push notifications; reading and changing the preference works either way.',
  })
  @ApiOkResponse({ schema: NOTIFICATION_PREFERENCES_SCHEMA })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  async get(@CurrentUser() user: AuthenticatedUser): Promise<NotificationPreferencesView> {
    return this.view(await this.preferences.getForUser(user.id));
  }

  @Patch()
  @ApiOperation({
    summary: 'Opt in or out of push notifications',
    description:
      'Idempotent. `true` while already on keeps the original `pushEnabledAt`; `false` while already off changes nothing. ' +
      'Opting out keeps registered devices and every inbox notification; opting in again starts a new opt-in period and never pushes older notifications. ' +
      'Opting in does not require a registered device. Concurrent requests: the last one applied by the database wins.',
  })
  @ApiBody({ type: UpdateNotificationPreferencesDto })
  @ApiOkResponse({ schema: NOTIFICATION_PREFERENCES_SCHEMA })
  @ApiBadRequestResponse({ description: '`pushEnabled` missing or not a JSON boolean, or unknown properties (e.g. userId).' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  async update(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateNotificationPreferencesDto): Promise<NotificationPreferencesView> {
    return this.view(await this.preferences.updateForUser(user.id, dto.pushEnabled));
  }

  private view(state: NotificationPreferenceState): NotificationPreferencesView {
    return {
      pushEnabled: state.pushEnabled,
      pushEnabledAt: state.pushEnabledAt ? new Date(state.pushEnabledAt).toISOString() : null,
      pushAvailable: this.preferences.pushAvailable,
      updatedAt: state.updatedAt ? new Date(state.updatedAt).toISOString() : null,
    };
  }
}
