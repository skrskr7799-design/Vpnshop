import { z } from "zod";

export const supportCategory = z.enum(["PAYMENT", "DELIVERY", "ACCESS", "OTHER", "GENERAL", "SUBSCRIPTION", "TECHNICAL", "ACCOUNT"]);
export const supportStatus = z.enum(["OPEN", "WAITING_CUSTOMER", "RESOLVED", "IN_PROGRESS", "CLOSED"]);
export const supportPriority = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);
export const supportText = z.string().trim().min(1).max(2000)
  .refine(text => !text.includes("\0"), "Недопустимый символ");
export const supportCreate = z.strictObject({
  category: supportCategory, orderId: z.uuid().optional(), message: supportText, subject: supportText.max(120).optional(),
});
export const supportReply = z.strictObject({ message: supportText });
export const supportChange = z.strictObject({
  status: supportStatus.optional(), publicReply: supportText.optional(), priority: supportPriority.optional(), assigneeId: z.uuid().nullable().optional(),
}).refine(data => Object.keys(data).length > 0);
export const staffSupportAction = z.strictObject({
  status: supportStatus.optional(), publicReply: supportText.optional(),
  expectedUpdatedAt: z.iso.datetime(), reason: z.string().trim().min(1).max(500),
}).refine(data => data.status !== undefined || data.publicReply !== undefined);

export type CaseSummary = {
  id: string; category: z.infer<typeof supportCategory>; orderId: string | null;
  subject?: string | null; unread?: number;
  status: z.infer<typeof supportStatus>; createdAt: string; updatedAt: string;
};
export type SupportMessageDto = { id: string; author: "CUSTOMER" | "STAFF"; text: string; createdAt: string };
export type SupportStatusDto = { id: string; status: CaseSummary["status"]; createdAt: string };
export type SupportDetail = {
  case: CaseSummary;
  readThrough?: string;
  messages: { items: SupportMessageDto[]; nextCursor: string | null };
  history: { items: SupportStatusDto[]; nextCursor: string | null };
};
