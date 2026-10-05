import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// src/payments/entities/payment.entity.ts
import { Booking } from '../../bookings/entities/booking.entity';

@Entity({ name: 'payments' })
@Check('chk_payments_amount', `"amount" >= 0`)
@Check(
  'chk_payments_method',
  `"method" IS NULL OR "method" IN ('CASH', 'QR', 'BANK_TRANSFER', 'OTHER')`,
)
@Check(
  'chk_payments_status',
  `"payment_status" IN ('UNPAID', 'PAID', 'FAILED')`,
)
export class Payment {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'booking_id', type: 'bigint', unique: true })
  bookingId!: string;

  @Column({ type: 'numeric', precision: 12, scale: 2 })
  amount!: string;

  @Column({ type: 'varchar', length: 30, nullable: true })
  method!: 'CASH' | 'QR' | 'BANK_TRANSFER' | 'OTHER' | null;

  @Index('idx_payments_status')
  @Column({
    name: 'payment_status',
    type: 'varchar',
    length: 20,
    default: 'UNPAID',
  })
  paymentStatus!: 'UNPAID' | 'PAID' | 'FAILED';

  @Index('idx_payments_paid_at')
  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'NOW()',
  })
  createdAt!: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamptz',
    default: () => 'NOW()',
  })
  updatedAt!: Date;

  @OneToOne(() => Booking, (booking) => booking.payment, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'booking_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_payments_booking',
  })
  booking!: Booking;
}
