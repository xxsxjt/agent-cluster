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
import { Bot, Loader2, Plus, Send, Trash2, User } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

import {
  createAssistantConversation,
  deleteAssistantConversation,
  getAssistantMessages,
  listAssistantConversations,
  sendAssistantQQMessage,
  sendAssistantMessage,
  type AssistantConversation,
  type AssistantMessage,
} from './api'

type ConversationPanelProps = {
  kind?: 'manual' | 'automatic' | 'qq' | 'twin'
}

export function ConversationPanel(props: ConversationPanelProps) {
  const kind = props.kind ?? 'manual'
  const [conversations, setConversations] = useState<AssistantConversation[]>(
    []
  )
  const [activeId, setActiveId] = useState<number | null>(null)
  const [messages, setMessages] = useState<AssistantMessage[]>([])
  const [input, setInput] = useState('')
  const [applyActions, setApplyActions] = useState(true)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [actionNotice, setActionNotice] = useState('')

  const loadMessages = useCallback(async (conversationId: number) => {
    const response = await getAssistantMessages(conversationId)
    if (response.success) setMessages(response.data ?? [])
  }, [])

  const refreshConversations = useCallback(async () => {
    const response = await listAssistantConversations(kind)
    if (!response.success) return
    let next = response.data ?? []
    if (kind === 'manual' && next.length === 0) {
      const created = await createAssistantConversation()
      if (created.success) next = [created.data]
    }
    setConversations(next)
    setActiveId((current) =>
      current && next.some((item) => item.id === current)
        ? current
        : (next[0]?.id ?? null)
    )
  }, [kind])

  useEffect(() => {
    void refreshConversations()
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }, [refreshConversations])

  useEffect(() => {
    if (!activeId) {
      setMessages([])
      return
    }
    setActionNotice('')
    void loadMessages(activeId).catch(() => undefined)
  }, [activeId, loadMessages])

  const createConversation = async () => {
    if (kind !== 'manual') return
    try {
      const response = await createAssistantConversation()
      if (!response.success) return
      setConversations((current) => [response.data, ...current])
      setActiveId(response.data.id)
      setMessages([])
    } catch {
      return
    }
  }

  const removeConversation = async (conversation: AssistantConversation) => {
    if (conversation.kind !== 'manual') return
    if (!window.confirm(`删除对话“${conversation.title}”？`)) return
    try {
      const response = await deleteAssistantConversation(conversation.id)
      if (!response.success) return
      const next = conversations.filter((item) => item.id !== conversation.id)
      setConversations(next)
      setActiveId(next[0]?.id ?? null)
      if (next.length === 0) await refreshConversations()
    } catch {
      return
    }
  }

  const send = async () => {
    const message = input.trim()
    if (!activeId || !message || sending) return
    setSending(true)
    setInput('')
    setActionNotice('')
    try {
      if (kind === 'qq') {
        const response = await sendAssistantQQMessage(activeId, message)
        const sentMessage = response.data
        if (response.success && sentMessage) {
          setMessages((current) => [...current, sentMessage])
        } else {
          toast.error(response.message || 'QQ 消息发送失败')
        }
        return
      }
      const response = await sendAssistantMessage(activeId, {
        message,
        apply: applyActions,
      })
      const data = response.data
      if (data) {
        setMessages((current) => [
          ...current,
          data.user_message,
          data.assistant_message,
        ])
        setConversations((current) =>
          current
            .map((item) =>
              item.id === data.conversation.id ? data.conversation : item
            )
            .sort((a, b) => b.updated_at - a.updated_at)
        )
        const applied = data.applied ?? []
        if (applied.length > 0) {
          setActionNotice(formatAppliedActions(applied))
        }
      }
      if (!response.success) toast.error(response.message || '管理动作执行失败')
    } catch {
      return
    } finally {
      setSending(false)
    }
  }

  let panelTitle = '管理对话'
  let emptyMessage =
    '直接说明要管理的内容，或粘贴 API Base 与 Key 创建临时渠道。'
  if (kind === 'qq') {
    panelTitle = 'QQ 会话'
    emptyMessage = '收到 QQ 消息或告警后，会话会显示在这里。'
  } else if (kind === 'automatic') {
    panelTitle = '自动巡检'
    emptyMessage = '启用自动任务或点击立即巡检后，结果会持续保存在这里。'
  } else if (kind === 'twin') {
    panelTitle = '虚无圣灵（分身）'
    emptyMessage = '这是本机分身（虚无圣灵）的对话记录，与电脑控制台一致。发消息即可开始对话。'
  }

  return (
    <div className='border-border grid h-[68vh] max-h-[780px] min-h-[540px] overflow-hidden rounded-md border md:grid-cols-[220px_minmax(0,1fr)]'>
      <aside className='bg-muted/20 flex min-h-0 flex-col border-b md:border-r md:border-b-0'>
        <div className='flex h-12 items-center justify-between border-b px-3'>
          <span className='text-sm font-medium'>{panelTitle}</span>
          {kind === 'manual' && (
            <Button
              size='icon-sm'
              variant='ghost'
              title='新建对话'
              onClick={createConversation}
            >
              <Plus />
            </Button>
          )}
        </div>
        <ScrollArea className='max-h-36 flex-1 md:max-h-none'>
          <div className='space-y-1 p-2'>
            {conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={cn(
                  'group flex items-center gap-1 rounded-md',
                  activeId === conversation.id && 'bg-accent'
                )}
              >
                <button
                  type='button'
                  className='min-w-0 flex-1 truncate px-2 py-2 text-left text-sm'
                  onClick={() => setActiveId(conversation.id)}
                >
                  {conversation.title}
                </button>
                {conversation.kind === 'manual' && (
                  <Button
                    size='icon-sm'
                    variant='ghost'
                    className='shrink-0 opacity-0 group-hover:opacity-100'
                    title='删除对话'
                    onClick={() => removeConversation(conversation)}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            ))}
            {loading && (
              <div className='text-muted-foreground flex items-center gap-2 p-2 text-sm'>
                <Loader2 className='animate-spin' /> 正在读取
              </div>
            )}
          </div>
        </ScrollArea>
      </aside>

      <section className='flex min-h-0 min-w-0 flex-col'>
        <ScrollArea className='min-h-0 flex-1'>
          <div className='mx-auto flex max-w-4xl flex-col gap-5 p-4 md:p-6'>
            {messages.length === 0 && !loading && (
              <div className='text-muted-foreground py-20 text-center text-sm'>
                {emptyMessage}
              </div>
            )}
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  'flex items-start gap-3',
                  message.role === 'user' && 'flex-row-reverse'
                )}
              >
                <div className='bg-muted flex size-8 shrink-0 items-center justify-center rounded-full'>
                  {message.role === 'user' ? <User /> : <Bot />}
                </div>
                <div
                  className={cn(
                    'max-w-[85%] rounded-md px-4 py-3 text-sm',
                    message.role === 'user'
                      ? 'bg-primary text-primary-foreground whitespace-pre-wrap'
                      : 'bg-muted/60'
                  )}
                >
                  {message.role === 'user' ? (
                    message.content
                  ) : (
                    <Markdown>{message.content}</Markdown>
                  )}
                </div>
              </div>
            ))}
            {sending && (
              <div className='text-muted-foreground flex items-center gap-2 text-sm'>
                <Loader2 className='animate-spin' /> 助手正在处理
              </div>
            )}
          </div>
        </ScrollArea>

        {actionNotice && (
          <div className='border-t bg-emerald-500/10 px-4 py-2 text-sm whitespace-pre-wrap text-emerald-700 dark:text-emerald-300'>
            {actionNotice}
          </div>
        )}
        {kind !== 'automatic' && (
          <div className='bg-background border-t p-3'>
            <div className='mx-auto max-w-4xl space-y-2'>
              <Textarea
                className='max-h-40 min-h-20 resize-none'
                value={input}
                placeholder={
                  kind === 'twin'
                    ? '给本机分身（虚无圣灵）发消息…'
                    : '输入管理指令，Enter 换行后点击发送'
                }
                onChange={(event) => setInput(event.target.value)}
              />
              <div className='flex items-center justify-between gap-3'>
                {kind === 'manual' ? (
                  <label className='flex items-center gap-2 text-sm'>
                    <Switch
                      checked={applyActions}
                      onCheckedChange={setApplyActions}
                    />
                    执行通过校验的管理动作
                  </label>
                ) : kind === 'twin' ? (
                  <span className='text-muted-foreground text-sm'>
                    消息将发送到本机分身（虚无圣灵），记录实时同步本机
                  </span>
                ) : (
                  <span className='text-muted-foreground text-sm'>
                    消息将发送到当前 QQ 会话
                  </span>
                )}
                <Button
                  onClick={send}
                  disabled={!input.trim() || sending || !activeId}
                >
                  {sending ? <Loader2 className='animate-spin' /> : <Send />}
                  发送
                </Button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

function formatAppliedActions(actions: Array<Record<string, unknown>>) {
  const lines = actions.map((action) => {
    if (action.type === 'create_trial_user') {
      return `试用用户：${action.username}\n临时密码：${action.password}`
    }
    if (action.type === 'create_redemption') {
      const keys = Array.isArray(action.keys) ? action.keys.join(', ') : ''
      return `兑换码：${keys}`
    }
    if (action.type === 'quick_add_temporary_channel') {
      return `临时渠道已创建：#${action.id} ${action.name}`
    }
    return `已执行：${String(action.type || '管理动作')}`
  })
  return lines.join('\n\n')
}
