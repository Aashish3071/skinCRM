import { pgEnum } from "drizzle-orm/pg-core";
import {
  ACTIVITY_TYPES,
  AUTOMATION_STATUSES,
  AUTOMATION_TRIGGERS,
  ENROLLMENT_STATES,
  APPOINTMENT_STATUSES,
  AUDIT_ACTIONS,
  CONSENT_PURPOSES,
  CONSENT_SOURCES,
  CONSENT_STATUSES,
  CONTACT_ATTEMPT_OUTCOMES,
  CONTACT_CHANNELS,
  CONVERSATION_STATUSES,
  FEEDBACK_DESTINATIONS,
  FEEDBACK_ELIGIBILITY_STATES,
  FEEDBACK_EVENT_STATES,
  FEEDBACK_MATCH_KEYS,
  FEEDBACK_MILESTONES,
  INGEST_STATUSES,
  INTEGRATION_HEALTH_STATES,
  INTEGRATION_PROVIDERS,
  LEAD_SOURCES,
  MESSAGE_DELIVERY_STATES,
  MESSAGE_DIRECTIONS,
  SOURCE_PLATFORMS,
  STAGE_CATEGORIES,
  SUPPRESSION_REASONS,
  TASK_OUTCOMES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TEMPLATE_CLASSIFICATIONS,
  USER_ROLES,
  USER_STATUSES,
  WHATSAPP_MESSAGE_TYPES,
  WHATSAPP_TEMPLATE_STATUSES,
} from "@skincrm/contracts";

/**
 * Postgres enums generated from the shared contract arrays, so a value can
 * never exist in TypeScript without existing in the database. Adding a value
 * means editing packages/contracts/src/enums.ts and running `pnpm db:generate`.
 */

// Drizzle needs a non-empty tuple type; the contract arrays are `as const`.
const tuple = <T extends string>(values: readonly T[]): [T, ...T[]] => values as unknown as [T, ...T[]];

export const userRoleEnum = pgEnum("user_role", tuple(USER_ROLES));
export const userStatusEnum = pgEnum("user_status", tuple(USER_STATUSES));

export const stageCategoryEnum = pgEnum("stage_category", tuple(STAGE_CATEGORIES));
export const leadSourceEnum = pgEnum("lead_source", tuple(LEAD_SOURCES));
export const sourcePlatformEnum = pgEnum("source_platform", tuple(SOURCE_PLATFORMS));
export const ingestStatusEnum = pgEnum("ingest_status", tuple(INGEST_STATUSES));

export const taskStatusEnum = pgEnum("task_status", tuple(TASK_STATUSES));
export const taskPriorityEnum = pgEnum("task_priority", tuple(TASK_PRIORITIES));
export const taskOutcomeEnum = pgEnum("task_outcome", tuple(TASK_OUTCOMES));
export const activityTypeEnum = pgEnum("activity_type", tuple(ACTIVITY_TYPES));
export const contactAttemptOutcomeEnum = pgEnum(
  "contact_attempt_outcome",
  tuple(CONTACT_ATTEMPT_OUTCOMES),
);

export const appointmentStatusEnum = pgEnum("appointment_status", tuple(APPOINTMENT_STATUSES));

export const contactChannelEnum = pgEnum("contact_channel", tuple(CONTACT_CHANNELS));
export const consentPurposeEnum = pgEnum("consent_purpose", tuple(CONSENT_PURPOSES));
export const consentStatusEnum = pgEnum("consent_status", tuple(CONSENT_STATUSES));
export const consentSourceEnum = pgEnum("consent_source", tuple(CONSENT_SOURCES));

export const templateClassificationEnum = pgEnum(
  "template_classification",
  tuple(TEMPLATE_CLASSIFICATIONS),
);
export const messageDirectionEnum = pgEnum("message_direction", tuple(MESSAGE_DIRECTIONS));
export const messageDeliveryStateEnum = pgEnum(
  "message_delivery_state",
  tuple(MESSAGE_DELIVERY_STATES),
);
export const suppressionReasonEnum = pgEnum("suppression_reason", tuple(SUPPRESSION_REASONS));

export const whatsappMessageTypeEnum = pgEnum("whatsapp_message_type", tuple(WHATSAPP_MESSAGE_TYPES));
export const conversationStatusEnum = pgEnum("conversation_status", tuple(CONVERSATION_STATUSES));
export const whatsappTemplateStatusEnum = pgEnum(
  "whatsapp_template_status",
  tuple(WHATSAPP_TEMPLATE_STATUSES),
);

export const integrationProviderEnum = pgEnum("integration_provider", tuple(INTEGRATION_PROVIDERS));
export const integrationHealthStateEnum = pgEnum(
  "integration_health_state",
  tuple(INTEGRATION_HEALTH_STATES),
);

export const feedbackDestinationEnum = pgEnum("feedback_destination", tuple(FEEDBACK_DESTINATIONS));
export const feedbackMilestoneEnum = pgEnum("feedback_milestone", tuple(FEEDBACK_MILESTONES));
export const feedbackEventStateEnum = pgEnum("feedback_event_state", tuple(FEEDBACK_EVENT_STATES));
export const feedbackMatchKeyEnum = pgEnum("feedback_match_key", tuple(FEEDBACK_MATCH_KEYS));
export const feedbackEligibilityStateEnum = pgEnum(
  "feedback_eligibility_state",
  tuple(FEEDBACK_ELIGIBILITY_STATES),
);

export const auditActionEnum = pgEnum("audit_action", tuple(AUDIT_ACTIONS));

export const automationTriggerEnum = pgEnum("automation_trigger", tuple(AUTOMATION_TRIGGERS));
export const automationStatusEnum = pgEnum("automation_status", tuple(AUTOMATION_STATUSES));
export const enrollmentStateEnum = pgEnum("enrollment_state", tuple(ENROLLMENT_STATES));
