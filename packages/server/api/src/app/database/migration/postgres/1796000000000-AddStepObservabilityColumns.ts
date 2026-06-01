import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddStepObservabilityColumns1796000000000 implements Migration {
    name = 'AddStepObservabilityColumns1796000000000'
    breaking = false
    release = '0.83.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "flow_run_step"
            ADD "queuedAt" TIMESTAMP WITH TIME ZONE
        `)
        await queryRunner.query(`
            ALTER TABLE "flow_run_step"
            ADD "startedAt" TIMESTAMP WITH TIME ZONE
        `)
        await queryRunner.query(`
            ALTER TABLE "flow_run_step"
            ADD "finishedAt" TIMESTAMP WITH TIME ZONE
        `)
        await queryRunner.query(`
            ALTER TABLE "flow_run_step"
            ADD "retryCount" integer NOT NULL DEFAULT 0
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "flow_run_step" DROP COLUMN "retryCount"')
        await queryRunner.query('ALTER TABLE "flow_run_step" DROP COLUMN "finishedAt"')
        await queryRunner.query('ALTER TABLE "flow_run_step" DROP COLUMN "startedAt"')
        await queryRunner.query('ALTER TABLE "flow_run_step" DROP COLUMN "queuedAt"')
    }
}