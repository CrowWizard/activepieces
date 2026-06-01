import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddStepLevelSchedulingEnabled1795000000000 implements Migration {
    name = 'AddStepLevelSchedulingEnabled1795000000000'
    breaking = false
    release = '0.83.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "platform_plan" ADD "stepLevelSchedulingEnabled" boolean NOT NULL DEFAULT false')
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "platform_plan" DROP COLUMN "stepLevelSchedulingEnabled"')
    }
}
