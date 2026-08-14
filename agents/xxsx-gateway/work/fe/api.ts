/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { api } from '@/lib/api'

export type CompositeModelConfig = {
  strategy: string
  groups: string[]
  model_groups: string[]
  targets: Array<{ channel_id: number; model: string }>
}

export type ManagementConfig = {
  model_groups: Record<string, string[]>
  model_group_access: Record<string, string[]>
  model_aliases: Record<string, string[]>
  composite_models: Record<string, CompositeModelConfig>
}

export type ManagementConfigResponse = {
  management: ManagementConfig
  groups: Record<string, number>
  enabled_models: string[]
  channels: Array<{
    id: number
    name: string
    type: number
    status: number
    models: string
    group: string
    tag: string
    model_mapping: string
  }>
}

export type AssistantStatus = {
  config: {
    model: string
    auto_task_enabled: boolean
    auto_task_interval_minutes: number
    auto_task_prompt: string
  }
  secrets: Record<string, boolean>
  channel_count: number
  enabled_models: number
  group_count: number
  automatic_task: AutomaticTaskStatus
}

export type AutomaticTaskStatus = {
  running: boolean
  last_run_at?: number
  next_run_at?: number
  last_error?: string
  conversation_id?: number
}

export type AssistantConversation = {
  id: number
  title: string
  kind: 'manual' | 'automatic' | 'qq' | 'twin'
  created_at: number
  updated_at: number
}

export type AssistantMessage = {
  id: number
  conversation_id: number
  role: 'user' | 'assistant' | 'system'
  content: string
  metadata?: string
  created_at: number
}

export type SecurityDefenseStatus = {
  config: {
    enabled: boolean
    auto_activate_enabled: boolean
    mode: string
    model: string
    skill_path: string
    spike_window_seconds: number
    spike_ratio: number
    min_window_requests: number
    auto_active_ttl_seconds: number
    inspect_content_enabled: boolean
    scheduled_scan_enabled: boolean
    scheduled_scan_interval_minutes: number
    qq_bot_enabled: boolean
    qq_bot_command_enabled: boolean
    qq_bot_target: string
    qq_bot_allowed_senders: string
  }
  secrets: Record<string, boolean>
  effective_active: boolean
  effective_mode: string
  window_count: number
  baseline_count: number
  next_scheduled_scan?: string
  scheduled_scan_running: boolean
  last_automatic_scan?: Record<string, unknown>
  last_scheduled_scan?: Record<string, unknown>
}

export type SecurityDefenseConfigUpdate = Partial<
  SecurityDefenseStatus['config'] & {
    qq_bot_webhook_secret: string
    qq_bot_token: string
    qq_bot_inbound_secret: string
  }
>

export type RequestDiagnostic = {
  id: number
  created_at: number
  request_id: string
  user_id: number
  username: string
  client_ip: string
  method: string
  path: string
  route_tag: string
  status: number
  stage: string
  latency_ms: number
  access_mode: string
  host: string
  protocol: string
  auth_type: string
  user_agent: string
  model_name: string
  channel_id: number
  error_code: string
  request_preview: string
  response_preview: string
}

export type DiagnosticRuntime = {
  queue_depth: number
  queue_capacity: number
  dropped: number
  retention_days: number
}

export type DiagnosticFilters = {
  p?: number
  page_size?: number
  keyword?: string
  client_ip?: string
  stage?: string
  access_mode?: string
  path?: string
  request_id?: string
  status?: number
  user_id?: number
  start_timestamp?: number
  end_timestamp?: number
}

export type TemporaryChannelPayload = {
  name: string
  type: number
  base_url: string
  api_key: string
  models: string
  group: string
  expires_in_minutes?: number
  max_requests?: number
  max_quota?: number
  priority?: number
  weight?: number
  note?: string
}

export async function getAssistantStatus() {
  const res = await api.get('/api/admin/assistant/status')
  return res.data as { success: boolean; data: AssistantStatus }
}

export async function updateAssistantConfig(data: {
  model?: string
  auto_task_enabled?: boolean
  auto_task_interval_minutes?: number
  auto_task_prompt?: string
}) {
  const res = await api.put('/api/admin/assistant/config', data)
  return res.data as {
    success: boolean
    data: AssistantStatus
    message?: string
  }
}

export async function runAssistantCommand(data: {
  command: string
  apply?: boolean
  actions?: unknown[]
}) {
  const res = await api.post('/api/admin/assistant/command', data)
  return res.data as { success: boolean; data: unknown; message?: string }
}

export async function getManagementConfig() {
  const res = await api.get('/api/admin/assistant/management-config')
  return res.data as { success: boolean; data: ManagementConfigResponse }
}

export async function saveManagementConfig(data: Partial<ManagementConfig>) {
  const res = await api.put('/api/admin/assistant/management-config', data)
  return res.data as {
    success: boolean
    data: ManagementConfigResponse
    message?: string
  }
}

export async function quickAddTemporaryChannel(data: TemporaryChannelPayload) {
  const res = await api.post('/api/channel/temporary/quick_add', data)
  return res.data as { success: boolean; data?: unknown; message?: string }
}

export async function listAssistantConversations(
  kind: 'manual' | 'automatic' | 'qq' | 'twin' = 'manual'
) {
  const res = await api.get('/api/admin/assistant/conversations', {
    params: { kind },
  })
  return res.data as { success: boolean; data: AssistantConversation[] }
}

export async function runAssistantAutomaticTask() {
  const res = await api.post('/api/admin/assistant/automatic/run')
  return res.data as {
    success: boolean
    data: AutomaticTaskStatus
    message?: string
  }
}

export async function sendAssistantQQMessage(id: number, message: string) {
  const res = await api.post(
    `/api/admin/assistant/conversations/${id}/qq-send`,
    { message }
  )
  return res.data as {
    success: boolean
    data?: AssistantMessage
    message?: string
  }
}

export async function getRequestDiagnostics(filters: DiagnosticFilters) {
  const res = await api.get('/api/admin/assistant/diagnostics', {
    params: filters,
  })
  return res.data as {
    success: boolean
    data: {
      page: {
        page: number
        page_size: number
        total: number
        items: RequestDiagnostic[]
      }
      runtime: DiagnosticRuntime
    }
  }
}

export async function getRequestDiagnostic(id: number) {
  const res = await api.get(`/api/admin/assistant/diagnostics/${id}`)
  return res.data as { success: boolean; data: RequestDiagnostic }
}

export async function cleanupRequestDiagnostics(days: number) {
  const res = await api.delete('/api/admin/assistant/diagnostics', {
    params: { days },
  })
  return res.data as { success: boolean; data: number; message?: string }
}

export async function createAssistantConversation(title = '') {
  const res = await api.post('/api/admin/assistant/conversations', { title })
  return res.data as { success: boolean; data: AssistantConversation }
}

export async function deleteAssistantConversation(id: number) {
  const res = await api.delete(`/api/admin/assistant/conversations/${id}`)
  return res.data as { success: boolean }
}

export async function getAssistantMessages(id: number) {
  const res = await api.get(`/api/admin/assistant/conversations/${id}/messages`)
  return res.data as { success: boolean; data: AssistantMessage[] }
}

export async function sendAssistantMessage(
  id: number,
  data: { message: string; apply: boolean }
) {
  const res = await api.post(
    `/api/admin/assistant/conversations/${id}/messages`,
    data
  )
  return res.data as {
    success: boolean
    message?: string
    data?: {
      conversation: AssistantConversation
      user_message: AssistantMessage
      assistant_message: AssistantMessage
      applied?: Array<Record<string, unknown>>
    }
  }
}

export async function getSecurityDefenseStatus() {
  const res = await api.get('/api/security/defense/status')
  return res.data as { success: boolean; data: SecurityDefenseStatus }
}

export async function updateSecurityDefenseConfig(
  data: SecurityDefenseConfigUpdate
) {
  const res = await api.put('/api/security/defense/config', data)
  return res.data as {
    success: boolean
    data: SecurityDefenseStatus
    message?: string
  }
}

export async function scanSecurityDefense() {
  const res = await api.post('/api/security/defense/scan')
  return res.data as {
    success: boolean
    data: Record<string, unknown>
    message?: string
  }
}

export async function testSecurityDefenseAlert() {
  const res = await api.post('/api/security/defense/alert/test')
  return res.data as { success: boolean; message?: string }
}
