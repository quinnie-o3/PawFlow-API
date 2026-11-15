import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { createMailTransport, MAIL_TRANSPORT } from './mail-transport';
import { MailService } from './mail.service';

/** P3-BE02: transactional e-mail (password reset, e-mail verification). */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => createMailTransport(configService),
    },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
