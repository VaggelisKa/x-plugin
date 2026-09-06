import { z } from 'zod';

const postId = z.string().regex(/^\d{1,19}$/);
const windowFields = {
  start_time: z.iso.datetime().optional().describe('UTC ISO timestamp, e.g. 2026-09-05T08:00:00Z'),
  end_time: z.iso.datetime().optional().describe('Exclusive UTC ISO timestamp'),
};
const orderedWindow = (a: { start_time?: string; end_time?: string }) =>
  !a.start_time || !a.end_time || Date.parse(a.start_time) < Date.parse(a.end_time);
const windowError = { message: 'start_time must be earlier than end_time', path: ['end_time'] };

export const searchPostsSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(512)
      .refine((s) => s.trim().length > 0, 'Query cannot be blank')
      .describe(
        'X query: keywords, phrases, #hashtags, from:user, lang:en, -is:retweet, -is:reply. Maximum 512 characters for standard access.',
      ),
    max_results: z.number().int().min(10).max(100).default(20),
    pagination_token: z.string().min(1).max(4096).optional(),
    sort_order: z.enum(['recency', 'relevancy']).default('recency'),
    ...windowFields,
  })
  .strict()
  .refine(orderedWindow, windowError);

export const getPostSchema = z.object({ post_id: postId }).strict();
export const userPostsSchema = z
  .object({
    user_id: postId.describe('Numeric user ID; use x_lookup_user to resolve a username'),
    max_results: z.number().int().min(5).max(100).default(20),
    pagination_token: z.string().min(1).max(4096).optional(),
    exclude: z
      .array(z.enum(['replies', 'retweets']))
      .max(2)
      .optional(),
    ...windowFields,
  })
  .strict()
  .refine(orderedWindow, windowError);

export type SearchPosts = z.input<typeof searchPostsSchema>;
export type UserPosts = z.input<typeof userPostsSchema>;
export const postFields = {
  'post.fields': 'id,text,created_at,lang,public_metrics,conversation_id,note_post',
  expansions: 'author_id',
  'user.fields': 'id,name,username',
};
