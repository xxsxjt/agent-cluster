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
import {
  Bot,
  Boxes,
  MessageCircle,
  Plus,
  RefreshCw,
  Save,
  Wand2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { SectionPageLayout } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

import {
  getAssistantStatus,
  getManagementConfig,
  quickAddTemporaryChannel,
  saveManagementConfig,
  updateAssistantConfig,
  type AssistantStatus,
  type ManagementConfigResponse,
  type TemporaryChannelPayload,
} from './api'
import { AutomaticPanel } from './automatic-panel'
import { ConversationPanel } from './conversation-panel'
import { DiagnosticsPanel } from './diagnostics-panel'
import { SecurityPanel } from './security-panel'

const emptyManagement: ManagementConfigResponse = {
  management: {
    model_groups: {},
    model_group_access: {},
    model_aliases: {},
    composite_models: {},
  },
  groups: {},
  enabled_models: [],
  channels: [],
}

function pretty(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2)
}

function parseObject<T>(value: string, label: string): T {
  const parsed = JSON.parse(value || '{}')
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${label} 必须是 JSON 对象`)
  }
  return parsed as T
}

function splitList(value: string) {
  return value
    .split(/[\n,]/g)
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseTargets(value: string) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, ...rest] = line.split(':')
      const channelId = Number.parseInt(id.trim(), 10)
      const model = rest.join(':').trim()
      if (!channelId || !model) {
        throw new Error('目标格式应为 channel_id:model，每行一个')
      }
      return { channel_id: channelId, model }
    })
}

export function AdminAssistant() {
  const [status, setStatus] = useState<AssistantStatus | null>(null)
  const [management, setManagement] = useState(emptyManagement)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [model, setModel] = useState('ollama/minimax-m3')
  const [modelAliasesText, setModelAliasesText] = useState('{}')
  const [compositeModelsText, setCompositeModelsText] = useState('{}')
  const [temporary, setTemporary] = useState<TemporaryChannelPayload>({
    name: '临时渠道',
    type: 1,
    base_url: '',
    api_key: '',
    models: '',
    group: 'default',
    expires_in_minutes: 1440,
    max_requests: 0,
    max_quota: 0,
    note: 'AI 助手快速配置',
  })
  const [compositeDraft, setCompositeDraft] = useState({
    name: '',
    strategy: 'polling',
    groups: '',
    targets: '',
  })

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [statusRes, managementRes] = await Promise.all([
        getAssistantStatus(),
        getManagementConfig(),
      ])
      if (statusRes.success) {
        setStatus(statusRes.data)
        setModel(statusRes.data.config.model || 'ollama/minimax-m3')
      }
      if (managementRes.success) {
        const next = managementRes.data ?? emptyManagement
        setManagement(next)
        setModelAliasesText(pretty(next.management.model_aliases))
        setCompositeModelsText(pretty(next.management.composite_models))
      }
    } catch {
      return
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const groupOptions = useMemo(
    () => Object.keys(management.groups),
    [management.groups]
  )

  const saveAssistant = async () => {
    setSaving(true)
    try {
      const res = await updateAssistantConfig({
        model,
      })
      if (res.success) {
        setStatus(res.data)
        toast.success('AI 助手配置已保存')
      } else {
        toast.error(res.message || 'AI 助手配置保存失败')
      }
    } catch {
      return
    } finally {
      setSaving(false)
    }
  }

  const saveAllManagement = async () => {
    setSaving(true)
    try {
      const payload = {
        model_aliases: parseObject<Record<string, string[]>>(
          modelAliasesText,
          '统一模型别名'
        ),
        composite_models: parseObject<Record<string, never>>(
          compositeModelsText,
          '合成模型'
        ),
      }
      const res = await saveManagementConfig(payload)
      if (res.success) {
        toast.success('模型别名与合成模型已保存')
        await refresh()
      } else {
        toast.error(res.message || '模型别名与合成模型保存失败')
      }
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const addCompositeDraft = () => {
    try {
      const name = compositeDraft.name.trim()
      if (!name) throw new Error('请填写统一模型名')
      const groups = splitList(compositeDraft.groups)
      if (groups.length === 0) throw new Error('请选择至少一个原用户分组')
      const current = parseObject<Record<string, unknown>>(
        compositeModelsText,
        '合成模型'
      )
      current[name] = {
        strategy: compositeDraft.strategy,
        groups,
        model_groups: [],
        targets: parseTargets(compositeDraft.targets),
      }
      setCompositeModelsText(pretty(current))
      toast.success('已加入合成模型草稿，保存后生效')
    } catch (error) {
      toast.error((error as Error).message)
    }
  }

  const createTemporary = async () => {
    setSaving(true)
    try {
      const res = await quickAddTemporaryChannel({
        ...temporary,
        models: splitList(temporary.models).join(','),
      })
      if (res.success) {
        toast.success('临时渠道已创建')
        await refresh()
      } else {
        toast.error(res.message || '临时渠道创建失败')
      }
    } catch {
      return
    } finally {
      setSaving(false)
    }
  }

  return (
    <SectionPageLayout fixedContent>
      <SectionPageLayout.Title>AI 助手</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <Button
          variant='outline'
          size='sm'
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw className='h-4 w-4' />
          刷新
        </Button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <div className='flex h-full min-h-0 flex-col gap-4 overflow-auto pb-6'>
          <div className='grid gap-3 md:grid-cols-3'>
            <StatCard title='渠道' value={status?.channel_count ?? 0} />
            <StatCard title='启用模型' value={status?.enabled_models ?? 0} />
            <StatCard title='用户分组' value={status?.group_count ?? 0} />
          </div>
          <Tabs defaultValue='assistant' className='min-h-0 flex-1'>
            <TabsList className='max-w-full flex-wrap justify-start group-data-horizontal/tabs:h-auto'>
              <TabsTrigger value='assistant'>助手（分身）</TabsTrigger>
              <TabsTrigger value='manual'>管理对话</TabsTrigger>
              <TabsTrigger value='automatic'>自动会话</TabsTrigger>
              <TabsTrigger value='diagnostics'>请求诊断</TabsTrigger>
              <TabsTrigger value='qq'>QQ 窗口</TabsTrigger>
              <TabsTrigger value='temporary'>临时渠道</TabsTrigger>
              <TabsTrigger value='composite'>合成模型</TabsTrigger>
              <TabsTrigger value='security'>安全与 QQ</TabsTrigger>
            </TabsList>
            <TabsContent value='assistant' className='mt-4 space-y-4'>
              <Card>
                <CardHeader>
                  <CardTitle className='flex items-center gap-2 text-base'>
                    <Bot className='h-4 w-4' />
                    全站 AI 助手配置
                  </CardTitle>
                  <CardDescription>
                    使用站内任意可调用模型处理长期管理对话与安全检查。
                  </CardDescription>
                </CardHeader>
                <CardContent className='grid gap-3 md:grid-cols-[1fr_auto]'>
                  <Field label='默认模型' value={model} onChange={setModel} />
                  <div className='flex items-end'>
                    <Button onClick={saveAssistant} disabled={saving}>
                      <Save className='h-4 w-4' />
                      保存
                    </Button>
                  </div>
                </CardContent>
              </Card>
              {/* 助手（默认）= 本机分身（虚无圣灵）：对话记录代理读取本机 twin history */}
              <ConversationPanel kind='twin' />
            </TabsContent>
            <TabsContent value='manual' className='mt-4 space-y-4'>
              <Card>
                <CardHeader>
                  <CardTitle className='flex items-center gap-2 text-base'>
                    <Bot className='h-4 w-4' />
                    管理对话（Hermes）
                  </CardTitle>
                  <CardDescription>
                    服务器端 Hermes 管理对话，与分身独立，保存在 HK 本地。
                  </CardDescription>
                </CardHeader>
              </Card>
              <ConversationPanel kind='manual' />
            </TabsContent>
            <TabsContent value='automatic' className='mt-4'>
              <AutomaticPanel />
            </TabsContent>
            <TabsContent value='diagnostics' className='mt-4'>
              <DiagnosticsPanel />
            </TabsContent>
            <TabsContent value='qq' className='mt-4 space-y-4'>
              <Card>
                <CardHeader>
                  <CardTitle className='flex items-center gap-2 text-base'>
                    <MessageCircle /> QQ 双向窗口
                  </CardTitle>
                  <CardDescription>
                    告警和入站命令会形成长期会话；可从这里向当前 QQ
                    会话发送消息。
                  </CardDescription>
                </CardHeader>
              </Card>
              <ConversationPanel kind='qq' />
            </TabsContent>
            <TabsContent value='temporary' className='mt-4'>
              <Card>
                <CardHeader>
                  <CardTitle className='flex items-center gap-2 text-base'>
                    <Wand2 className='h-4 w-4' />
                    临时渠道快速配置
                  </CardTitle>
                  <CardDescription>
                    粘贴 API Base、Key 和模型列表，创建限时使用的渠道。
                  </CardDescription>
                </CardHeader>
                <CardContent className='grid gap-3 md:grid-cols-2'>
                  <Field
                    label='名称'
                    value={temporary.name}
                    onChange={(v) => setTemporary({ ...temporary, name: v })}
                  />
                  <Field
                    label='渠道类型'
                    type='number'
                    value={String(temporary.type)}
                    onChange={(v) =>
                      setTemporary({ ...temporary, type: Number(v) || 1 })
                    }
                  />
                  <Field
                    label='API Base'
                    value={temporary.base_url}
                    onChange={(v) =>
                      setTemporary({ ...temporary, base_url: v })
                    }
                  />
                  <Field
                    label='API Key'
                    type='password'
                    value={temporary.api_key}
                    onChange={(v) => setTemporary({ ...temporary, api_key: v })}
                  />
                  <div className='space-y-2 md:col-span-2'>
                    <Label>模型列表</Label>
                    <Textarea
                      value={temporary.models}
                      onChange={(e) =>
                        setTemporary({ ...temporary, models: e.target.value })
                      }
                      placeholder='gpt-4o-mini, claude-3-5-sonnet 或每行一个'
                    />
                  </div>
                  <div className='space-y-2'>
                    <Label>原用户分组</Label>
                    <Select
                      value={temporary.group}
                      onValueChange={(v) =>
                        setTemporary({ ...temporary, group: v ?? 'default' })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(groupOptions.length ? groupOptions : ['default']).map(
                          (group) => (
                            <SelectItem key={group} value={group}>
                              {group}
                            </SelectItem>
                          )
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  <Field
                    label='有效小时'
                    type='number'
                    value={String(
                      Math.floor((temporary.expires_in_minutes ?? 1440) / 60)
                    )}
                    onChange={(v) =>
                      setTemporary({
                        ...temporary,
                        expires_in_minutes: (Number(v) || 0) * 60,
                      })
                    }
                  />
                  <Field
                    label='最大请求数'
                    type='number'
                    value={String(temporary.max_requests ?? 0)}
                    onChange={(v) =>
                      setTemporary({
                        ...temporary,
                        max_requests: Number(v) || 0,
                      })
                    }
                  />
                  <Field
                    label='最大额度'
                    type='number'
                    value={String(temporary.max_quota ?? 0)}
                    onChange={(v) =>
                      setTemporary({ ...temporary, max_quota: Number(v) || 0 })
                    }
                  />
                  <Field
                    label='备注'
                    value={temporary.note ?? ''}
                    onChange={(v) => setTemporary({ ...temporary, note: v })}
                  />
                  <div className='md:col-span-2'>
                    <Button
                      onClick={createTemporary}
                      disabled={
                        saving || !temporary.base_url || !temporary.api_key
                      }
                    >
                      <Plus className='h-4 w-4' />
                      创建临时渠道
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value='composite' className='mt-4 space-y-4'>
              <Card>
                <CardHeader>
                  <CardTitle className='flex items-center gap-2 text-base'>
                    <Boxes className='h-4 w-4' />
                    合成模型生成器
                  </CardTitle>
                  <CardDescription>
                    把不同渠道的多个模型统一成一个前端调用名，支持轮询或随机。
                  </CardDescription>
                </CardHeader>
                <CardContent className='grid gap-3 md:grid-cols-2'>
                  <Field
                    label='统一模型名'
                    value={compositeDraft.name}
                    onChange={(v) =>
                      setCompositeDraft({ ...compositeDraft, name: v })
                    }
                    placeholder='glm-5.2-allauto'
                  />
                  <div className='space-y-2'>
                    <Label>策略</Label>
                    <Select
                      value={compositeDraft.strategy}
                      onValueChange={(v) =>
                        setCompositeDraft({
                          ...compositeDraft,
                          strategy: v ?? 'polling',
                        })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='polling'>轮询</SelectItem>
                        <SelectItem value='random'>随机</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Field
                    label='原用户分组'
                    value={compositeDraft.groups}
                    placeholder='default,vip；* 表示全部原分组'
                    onChange={(v) =>
                      setCompositeDraft({ ...compositeDraft, groups: v })
                    }
                  />
                  <div className='space-y-2 md:col-span-2'>
                    <Label>目标渠道和模型</Label>
                    <Textarea
                      value={compositeDraft.targets}
                      onChange={(e) =>
                        setCompositeDraft({
                          ...compositeDraft,
                          targets: e.target.value,
                        })
                      }
                      placeholder={'25:glm-5.2\n31:zhipu/glm-5.2'}
                    />
                  </div>
                  <div className='md:col-span-2'>
                    <Button onClick={addCompositeDraft}>
                      <Plus className='h-4 w-4' />
                      加入合成模型草稿
                    </Button>
                  </div>
                </CardContent>
              </Card>
              <JsonEditor
                title='合成模型 JSON'
                value={compositeModelsText}
                onChange={setCompositeModelsText}
              />
              <div className='grid gap-4 lg:grid-cols-2'>
                <JsonEditor
                  title='统一模型别名'
                  value={modelAliasesText}
                  onChange={setModelAliasesText}
                />
                <Card>
                  <CardHeader>
                    <CardTitle className='text-base'>当前渠道参考</CardTitle>
                    <CardDescription>
                      使用渠道 ID 与实际模型名填写目标，每行一个。
                    </CardDescription>
                  </CardHeader>
                  <CardContent className='max-h-80 overflow-auto text-sm'>
                    <div className='space-y-2'>
                      {management.channels.slice(0, 80).map((channel) => (
                        <div
                          key={channel.id}
                          className='flex items-center justify-between gap-3 rounded-md border p-2'
                        >
                          <div className='min-w-0'>
                            <div className='truncate font-medium'>
                              #{channel.id} {channel.name}
                            </div>
                            <div className='text-muted-foreground truncate text-xs'>
                              {channel.group} · {channel.models}
                            </div>
                          </div>
                          <Badge
                            variant={
                              channel.status === 1 ? 'default' : 'secondary'
                            }
                          >
                            {channel.status === 1 ? '启用' : '停用'}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
              <div className='flex justify-end'>
                <Button onClick={saveAllManagement} disabled={saving}>
                  <Save className='h-4 w-4' />
                  保存模型别名与合成模型
                </Button>
              </div>
            </TabsContent>
            <TabsContent value='security' className='mt-4'>
              <SecurityPanel />
            </TabsContent>
          </Tabs>
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}

function StatCard({ title, value }: { title: string; value: string | number }) {
  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardDescription>{title}</CardDescription>
        <CardTitle className='text-2xl'>{value}</CardTitle>
      </CardHeader>
    </Card>
  )
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  placeholder?: string
}) {
  return (
    <div className='space-y-2'>
      <Label>{label}</Label>
      <Input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

function JsonEditor({
  title,
  value,
  onChange,
}: {
  title: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <Textarea
          className='min-h-72 font-mono text-xs'
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </CardContent>
    </Card>
  )
}
