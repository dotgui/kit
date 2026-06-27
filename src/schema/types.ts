/**
 * The canonical .gui type definitions live in dotgui-core, the spec authority.
 * This file re-exports them so the kit (parser, validator, renderer, scorer)
 * consumes the format from the single source of truth — it does not define it.
 *
 * Source: ../../../core/schema/types.ts  —  see core/GOVERNANCE.md
 */
export * from '../../../core/schema/types.ts'
