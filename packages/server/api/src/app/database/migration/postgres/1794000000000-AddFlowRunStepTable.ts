import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class AddFlowRunStepTable1794000000000 implements Migration {
    name = 'AddFlowRunStepTable1794000000000'
    breaking = false
    release = '0.83.0'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "flow_run_step" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "flowRunId" character varying(21) NOT NULL,
                "projectId" character varying(21) NOT NULL,
                "stepName" character varying(255) NOT NULL,
                "stepType" character varying NOT NULL,
                "status" character varying NOT NULL,
                "input" jsonb,
                "output" jsonb,
                "duration" integer,
                "errorMessage" jsonb,
                "path" jsonb NOT NULL DEFAULT '[]',
                "queueName" character varying(255),
                CONSTRAINT "PK_flow_run_step_id" PRIMARY KEY ("id")
            )
        `)

        await queryRunner.query(`
            CREATE INDEX "idx_flow_run_step_flow_run_id"
            ON "flow_run_step" ("flowRunId")
        `)

        await queryRunner.query(`
            CREATE INDEX "idx_flow_run_step_flow_run_id_step_name"
            ON "flow_run_step" ("flowRunId", "stepName")
        `)

        await queryRunner.query(`
            CREATE INDEX "idx_flow_run_step_project_id"
            ON "flow_run_step" ("projectId")
        `)

        await queryRunner.query(`
            ALTER TABLE "flow_run_step"
            ADD CONSTRAINT "fk_flow_run_step_flow_run_id"
            FOREIGN KEY ("flowRunId") REFERENCES "flow_run"("id") ON DELETE CASCADE
        `)

        await queryRunner.query(`
            ALTER TABLE "flow_run_step"
            ADD CONSTRAINT "fk_flow_run_step_project_id"
            FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "flow_run_step" DROP CONSTRAINT IF EXISTS "fk_flow_run_step_flow_run_id"')
        await queryRunner.query('ALTER TABLE "flow_run_step" DROP CONSTRAINT IF EXISTS "fk_flow_run_step_project_id"')
        await queryRunner.query('DROP INDEX IF EXISTS "idx_flow_run_step_project_id"')
        await queryRunner.query('DROP INDEX IF EXISTS "idx_flow_run_step_flow_run_id_step_name"')
        await queryRunner.query('DROP INDEX IF EXISTS "idx_flow_run_step_flow_run_id"')
        await queryRunner.query('DROP TABLE IF EXISTS "flow_run_step"')
    }
}