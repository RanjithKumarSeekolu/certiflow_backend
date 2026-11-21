import { z } from "zod";

export const CreateBatchSchema = z.object({
  courseName: z.string().min(2, "Course name is required"),
});

export const CandidateRowSchema = z.object({
  fullName: z.string().min(2, "Full name must be at least 2 characters"),
  phone: z.string().regex(/^\+?[0-9]{10,13}$/, "Phone number must be 10-13 digits"),
  nationalId: z.string().min(4, "National ID / Aadhaar must be at least 4 characters"),
  score: z.coerce.number().min(0, "Score cannot be negative").max(100, "Score cannot exceed 100"),
  grade: z.string().optional(),
});

export const OfficerReviewSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED", "SENT_BACK"]),
  comments: z.string().optional(),
});

export type CreateBatchInput = z.infer<typeof CreateBatchSchema>;
export type CandidateRow = z.infer<typeof CandidateRowSchema>;
export type OfficerReviewInput = z.infer<typeof OfficerReviewSchema>;

