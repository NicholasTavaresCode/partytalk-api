import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateRoomDto } from './create-room.dto';

/** Validate a raw request body with class-validator alone. */
const check = (body: object) => validate(plainToInstance(CreateRoomDto, body));

/** The pipe exactly as AppModule configures it globally (whitelist + forbidNonWhitelisted). */
const globalPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
});
const throughPipe = (body: object) =>
  globalPipe.transform(body, { type: 'body', metatype: CreateRoomDto });

describe('CreateRoomDto', () => {
  it('accepts each of the five session lengths', async () => {
    for (const durationMinutes of [10, 15, 30, 45, 60]) {
      expect(await check({ topic: 'Weekend plans', durationMinutes })).toEqual(
        [],
      );
    }
  });

  it('rejects any other length (and non-numeric values)', async () => {
    for (const durationMinutes of [5, 20, 25, 90, 0, -10, 30.5, '30']) {
      const errors = await check({ topic: 'Weekend plans', durationMinutes });
      expect(errors.map((e) => e.property)).toContain('durationMinutes');
    }
  });

  it('lets the session length be omitted (the service applies the default)', async () => {
    expect(await check({ topic: 'Weekend plans' })).toEqual([]);
  });

  describe('opening topic', () => {
    it('requires a valid topic when the creator picks it', async () => {
      for (const body of [
        {},
        { topic: 'ab' },
        { topic: 42 },
        { hostPicksTopic: false },
      ]) {
        const errors = await check(body);
        expect(errors.map((e) => e.property)).toContain('topic');
      }
    });

    it('lets the topic be omitted, or ignores it, when the host picks', async () => {
      expect(await check({ hostPicksTopic: true })).toEqual([]);
      expect(await check({ hostPicksTopic: true, topic: 'ab' })).toEqual([]);
    });

    it('passes the global ValidationPipe with the host picking (whitelist keeps hostPicksTopic)', async () => {
      await expect(
        throughPipe({ hostPicksTopic: true, durationMinutes: 15 }),
      ).resolves.toMatchObject({ hostPicksTopic: true, durationMinutes: 15 });
    });

    it('still rejects unknown properties through the global pipe', async () => {
      const error = await throughPipe({
        topic: 'Weekend plans',
        bogus: 1,
      }).catch((e: BadRequestException) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        message: ['property bogus should not exist'],
      });
    });

    it('rejects a non-boolean hostPicksTopic', async () => {
      const errors = await check({
        topic: 'Weekend plans',
        hostPicksTopic: 'yes',
      });
      expect(errors.map((e) => e.property)).toContain('hostPicksTopic');
    });
  });
});
