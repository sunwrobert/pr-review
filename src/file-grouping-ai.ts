import { invoke } from '@tauri-apps/api/core';
import { buildGroupingPrompt, GROUPING_RESPONSE_SCHEMA, GROUPING_SYSTEM_PROMPT, parseGroupingResponse, type FileGrouping, type PromptFile } from './file-groups';

/** Picked over Claude Haiku 5.5 on 5 real PRs: about half the cost, same speed, no duplicated files. */
export const GROUPING_MODEL = 'openai/gpt-6-luna';

interface ChatResponse {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string };
}

export function buildGroupingRequest(title: string, description: string, files: readonly PromptFile[]): string {
  return JSON.stringify({
    model: GROUPING_MODEL,
    temperature: 0,
    messages: [
      { role: 'system', content: GROUPING_SYSTEM_PROMPT },
      { role: 'user', content: buildGroupingPrompt(title, description, files) },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'file_grouping', strict: true, schema: GROUPING_RESPONSE_SCHEMA } },
  });
}

export function readGroupingResponse(raw: string): FileGrouping {
  const response = JSON.parse(raw) as ChatResponse;
  const content = response.choices?.[0]?.message?.content;
  if (content == null || content === '') throw new Error(response.error?.message ?? 'grouping model returned nothing');
  return parseGroupingResponse(content);
}

export async function groupWithAi(title: string, description: string, files: readonly PromptFile[]): Promise<FileGrouping> {
  return readGroupingResponse(await invoke<string>('group_files', { request: buildGroupingRequest(title, description, files) }));
}
