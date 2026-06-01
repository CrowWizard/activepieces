import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddSchedulingModeToFlowRun1797000000000 implements Migration {
    name = 'AddSchedulingModeToFlowRun1797000000000'
    breaking = false
    release = '0.84.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "flow_run"
            ADD "schedulingMode" character varying(20) NOT NULL DEFAULT 'INTERNAL'
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "flow_run" DROP COLUMN "schedulingMode"')
    }
}
