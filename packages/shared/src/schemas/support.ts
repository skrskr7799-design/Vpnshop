import { z } from "zod";

export const supportCategory = z.enum(["PAYMENT", "DELIVERY", "ACCESS", "OTHER"]);
export const supportStatus = z.enum(["OPEN", "WAITING_CUSTOMER", "RESOLVED"]);
export const supportText = z.string().trim().min(1).max(2000)
  .refine(text => !text.includes("\0"), "Недопустимый символ");
export const supportCreate = z.strictObject({
  category: supportCategory, orderId: z.uuid().optional(), message: supportText,
});
export const supportReply = z.strictObject({ message: supportText });
export const staffSupportAction = z.strictObject({
  status: supportStatus.optional(), publicReply: supportText.optional(),
  expectedUpdatedAt: z.iso.datetime(), reason: z.string().trim().min(1).max(500),
}).refine(data => data.status !== undefined || data.publicReply !== undefined);

export type CaseSummary = {
  id: string; category: z.infer<typeof supportCategory>; orderId: string | null;
  status: z.infer<typeof supportStatus>; createdAt: string; updatedAt: string;
};
export type SupportMessageDto = { id: string; author: "CUSTOMER" | "STAFF"; text: string; createdAt: string };
export type SupportStatusDto = { id: string; status: CaseSummary["status"]; createdAt: string };
export type SupportDetail = {
  case: CaseSummary;
  messages: { items: SupportMessageDto[]; nextCursor: string | null };
  history: { items: SupportStatusDto[]; nextCursor: string | null };
};
