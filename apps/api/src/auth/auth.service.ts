import { Injectable, UnauthorizedException, ConflictException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { randomBytes, createHash } from 'crypto';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  // CB-010: Register with email/password
  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.prisma.user.create({
      data: { email: dto.email, passwordHash, role: dto.role ?? 'VISITOR' },
    });

    // Emit verification token (email sending handled by EmailService)
    const verifyToken = await this.createVerificationToken(user.id, 'email_verification');

    return { userId: user.id, email: user.email, verifyToken };
  }

  // CB-010: Login
  async login(dto: LoginDto, userAgent?: string, ipAddress?: string) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user?.passwordHash) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    if (user.status === 'BANNED') throw new UnauthorizedException('Account suspended');

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return this.issueTokenPair(user.id, user.role, userAgent, ipAddress);
  }

  // CB-012: Refresh token rotation
  async refresh(rawRefreshToken: string) {
    const tokenHash = this.hashToken(rawRefreshToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { token: tokenHash } });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      // Possible token theft — revoke all tokens for this user
      if (stored) {
        await this.prisma.refreshToken.updateMany({
          where: { userId: stored.userId },
          data: { revokedAt: new Date() },
        });
      }
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Revoke old token and issue new pair
    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: stored.userId } });
    return this.issueTokenPair(user.id, user.role);
  }

  // CB-010: Email verification
  async verifyEmail(token: string) {
    const record = await this.prisma.verificationToken.findUnique({ where: { token } });
    if (!record || record.type !== 'email_verification') throw new BadRequestException('Invalid token');
    if (record.expiresAt < new Date()) throw new BadRequestException('Token expired');
    if (record.usedAt) throw new BadRequestException('Token already used');

    await this.prisma.$transaction([
      this.prisma.verificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      this.prisma.user.update({ where: { id: record.userId }, data: { emailVerified: true } }),
    ]);
    return { success: true };
  }

  // CB-014: Forgot password
  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return; // Silent — don't leak email existence
    await this.createVerificationToken(user.id, 'password_reset');
    // Token returned here; email dispatch handled by EmailService
  }

  // CB-014: Reset password
  async resetPassword(token: string, newPassword: string) {
    const record = await this.prisma.verificationToken.findUnique({ where: { token } });
    if (!record || record.type !== 'password_reset') throw new BadRequestException('Invalid token');
    if (record.expiresAt < new Date()) throw new BadRequestException('Token expired — request a new link');
    if (record.usedAt) throw new BadRequestException('Token already used');

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.$transaction([
      this.prisma.verificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      this.prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
      // Revoke all existing refresh tokens (force re-login)
      this.prisma.refreshToken.updateMany({
        where: { userId: record.userId },
        data: { revokedAt: new Date() },
      }),
    ]);
    return { success: true };
  }

  // CB-012: Logout — revoke refresh token
  async logout(rawRefreshToken: string) {
    const tokenHash = this.hashToken(rawRefreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { token: tokenHash },
      data: { revokedAt: new Date() },
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────
  private async issueTokenPair(userId: string, role: string, userAgent?: string, ipAddress?: string) {
    const payload = { sub: userId, role };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.config.get('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get('JWT_ACCESS_EXPIRES_IN', '15m'),
    });

    const rawRefresh = randomBytes(64).toString('hex');
    const tokenHash = this.hashToken(rawRefresh);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await this.prisma.refreshToken.create({
      data: { token: tokenHash, userId, expiresAt, userAgent, ipAddress },
    });

    return { accessToken, refreshToken: rawRefresh, tokenType: 'Bearer' };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async createVerificationToken(userId: string, type: string): Promise<string> {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await this.prisma.verificationToken.create({ data: { token, userId, type, expiresAt } });
    return token;
  }
}