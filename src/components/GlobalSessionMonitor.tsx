import { useEffect, useRef } from 'react'
import { useChatStore } from '../stores/chatStore'
import type { ChatSession, Message } from '../types/models'
import { buildNewMessagesCursor } from '../pages/Chat/messageCursor'
import { displayNameOrFallback, pickDisplayName } from '../utils/displayName'

const RESUME_NOTIFICATION_QUIET_MS = 45_000
const RESUME_NOTIFICATION_SETTLE_MS = 10_000
const RESUME_NOTIFICATION_MAX_MS = 3 * 60_000
const SESSION_CHANGE_DEBOUNCE_MS = 400
const MIN_SESSION_REFRESH_INTERVAL_MS = 2_000
const MAX_NOTIFICATION_CANDIDATES_PER_REFRESH = 3

function isOwnGroupMessage(session: ChatSession): boolean {
    if (!session.username.includes('@chatroom') || !session.lastMsgSender || !session.selfWxid) return false
    const sender = session.lastMsgSender
    const self = session.selfWxid
    if (sender.replace(/^wxid_/, '') === self.replace(/^wxid_/, '')) return true
    const cleanSuffix = (id: string) => id.trim().replace(/_[a-zA-Z0-9]{4}$/, '')
    return cleanSuffix(sender) === cleanSuffix(self)
}

export function GlobalSessionMonitor() {
    const {
        sessions,
        setSessions,
        appendMessages
    } = useChatStore()

    const sessionsRef = useRef(sessions)
    const notificationQuietUntilRef = useRef(0)
    const notificationQuietMaxUntilRef = useRef(0)
    // 保持 ref 同步
    useEffect(() => {
        sessionsRef.current = sessions
    }, [sessions])

    // 去重辅助函数：获取消息 key
    const getMessageKey = (msg: Message) => {
        if (msg.messageKey) return msg.messageKey
        return `fallback:${msg._db_path || ''}:${msg.serverId || 0}:${msg.createTime}:${msg.sortSeq || 0}:${msg.localId || 0}:${msg.senderUsername || ''}:${msg.localType || 0}`
    }

    // 处理数据库变更（防抖 + 串行：微信同步期间 Session 表变更事件会连续触发，
    // 每次全量 getSessions + 富化的 IPC 成本高，合并突发事件只刷新一次）
    useEffect(() => {
        let debounceTimer: ReturnType<typeof setTimeout> | null = null
        let resumeDeadlineTimer: ReturnType<typeof setTimeout> | null = null
        let refreshing = false
        let pendingRefresh = false
        let pendingRefreshSuppressNotifications = false
        let scheduledSuppressNotifications = false
        let lastRefreshStartedAt = 0
        let sessionChangeSequence = 0
        let resumeDirty = false
        let disposed = false

        const scheduleRefresh = (delay: number, suppressNotifications: boolean) => {
            if (debounceTimer) clearTimeout(debounceTimer)
            scheduledSuppressNotifications = suppressNotifications
            const earliestNextRefresh = lastRefreshStartedAt + MIN_SESSION_REFRESH_INTERVAL_MS
            const remainingInterval = Math.max(0, earliestNextRefresh - Date.now())
            debounceTimer = setTimeout(() => {
                debounceTimer = null
                void runRefresh(scheduledSuppressNotifications)
            }, Math.max(delay, remainingInterval))
        }

        const runRefresh = async (suppressNotifications = false) => {
            if (refreshing) {
                pendingRefresh = true
                pendingRefreshSuppressNotifications ||= suppressNotifications
                return
            }
            refreshing = true
            lastRefreshStartedAt = Date.now()
            const refreshSequence = sessionChangeSequence
            try {
                const success = await refreshSessions(suppressNotifications)
                if (success && refreshSequence === sessionChangeSequence) resumeDirty = false
            } finally {
                refreshing = false
                if (pendingRefresh && !disposed) {
                    pendingRefresh = false
                    const suppressPending = pendingRefreshSuppressNotifications
                    pendingRefreshSuppressNotifications = false
                    // 读取期间的事件只需要一次尾随刷新。若新事件已有定时器，
                    // 让它继续防抖，避免在微信持续同步时形成全量读取循环。
                    if (!debounceTimer) {
                        const now = Date.now()
                        const recoveryDelay = Math.min(
                            RESUME_NOTIFICATION_SETTLE_MS,
                            Math.max(0, notificationQuietMaxUntilRef.current - now)
                        )
                        scheduleRefresh(
                            now < notificationQuietMaxUntilRef.current
                                ? recoveryDelay
                                : SESSION_CHANGE_DEBOUNCE_MS,
                            suppressPending
                        )
                    } else if (suppressPending) {
                        scheduledSuppressNotifications = true
                    }
                }
            }
        }

        const removeResumeListener = window.electronAPI.app.onSystemResume(() => {
            const now = Date.now()
            sessionChangeSequence += 1
            resumeDirty = true
            notificationQuietUntilRef.current = now + RESUME_NOTIFICATION_QUIET_MS
            notificationQuietMaxUntilRef.current = now + RESUME_NOTIFICATION_MAX_MS
            // 文件监听器可能在睡眠期间丢失事件。恢复后主动读取一次基线，
            // 并与接下来收到的 Session 变更合并。
            scheduleRefresh(RESUME_NOTIFICATION_SETTLE_MS, true)
            if (resumeDeadlineTimer) clearTimeout(resumeDeadlineTimer)
            resumeDeadlineTimer = setTimeout(() => {
                resumeDeadlineTimer = null
                if (!resumeDirty) return
                if (debounceTimer) clearTimeout(debounceTimer)
                debounceTimer = null
                void runRefresh(true)
            }, RESUME_NOTIFICATION_MAX_MS)
            console.info('[NotificationFilter] Scheduling a silent session resync after system resume')
        })

        const handleDbChange = (_event: any, data: { type: string; json: string }) => {
            try {
                const payload = JSON.parse(data.json)
                const tableName = payload.table

                // 只关注 Session 表
                if (tableName === 'Session' || tableName === 'session') {
                    sessionChangeSequence += 1
                    const now = Date.now()
                    if (now < notificationQuietMaxUntilRef.current) {
                        resumeDirty = true
                        notificationQuietUntilRef.current = Math.min(
                            notificationQuietMaxUntilRef.current,
                            now + RESUME_NOTIFICATION_SETTLE_MS
                        )

                        // 睡眠恢复的补同步可能连续改写 Session。先合并这些事件，
                        // 等变更安静下来后合并读取会话快照。
                        const catchupDelay = Math.min(
                            RESUME_NOTIFICATION_SETTLE_MS,
                            Math.max(0, notificationQuietMaxUntilRef.current - now)
                        )
                        scheduleRefresh(catchupDelay, true)
                        return
                    }
                    scheduleRefresh(SESSION_CHANGE_DEBOUNCE_MS, false)
                }
            } catch (e) {
                console.error('解析数据库变更失败:', e)
            }
        }

        const removeListener = window.electronAPI.chat.onWcdbChange?.(handleDbChange)
        return () => {
            disposed = true
            if (debounceTimer) clearTimeout(debounceTimer)
            if (resumeDeadlineTimer) clearTimeout(resumeDeadlineTimer)
            removeResumeListener()
            removeListener?.()
        }
    }, [])

    // 注意：导出统计的预加载已移除（前端全量预载曾导致内存从 200MB 飙升到 500+MB，
    // 主进程启动预热也因拖慢启动速度被移除）。
    // 导出页打开时按需拉取可见批次的会话统计，主进程有磁盘缓存兜底，响应速度足够快。


    const refreshSessions = async (suppressNotifications = false): Promise<boolean> => {
        try {
            const result = await window.electronAPI.chat.getSessions()
            if (result.success && result.sessions && Array.isArray(result.sessions)) {
                const newSessions = result.sessions as ChatSession[]
                const oldSessions = sessionsRef.current

                // 先更新会话列表。通知需要额外查询联系人，不能让弹窗准备阻塞界面。
                sessionsRef.current = newSessions
                setSessions(newSessions)

                // 活跃会话的消息刷新也应先于通知联系人查询启动。
                const currentId = useChatStore.getState().currentSessionId
                if (currentId) {
                    const currentSessionNew = newSessions.find(s => s.username === currentId)
                    const currentSessionOld = oldSessions.find(s => s.username === currentId)
                    if (currentSessionNew && (!currentSessionOld || currentSessionNew.lastTimestamp > currentSessionOld.lastTimestamp)) {
                        void handleActiveSessionRefresh(currentId)
                    }
                }

                // 恢复静默期间只更新基线，不逐条补发通知。
                if (!suppressNotifications && Date.now() >= notificationQuietUntilRef.current) {
                    await checkForNewMessages(oldSessions, newSessions)
                } else {
                    console.info('[NotificationFilter] Skipping notifications while session state catches up')
                }

                // 注意：不再在每次 Session 变更时全量预载导出统计
                // （2000+ 会话 × 多库统计查询的 IPC 风暴是卡顿主因之一；
                // 导出页会按需拉取可见行的统计，主进程有磁盘缓存兜底）
                return true
            }
        } catch (e) {
            console.error('全局会话刷新失败:', e)
        }
        return false
    }

    const checkForNewMessages = async (oldSessions: ChatSession[], newSessions: ChatSession[]) => {
        if (!oldSessions || oldSessions.length === 0) {
            console.log('[NotificationFilter] Skipping check on initial load (empty baseline)')
            return
        }

        const oldMap = new Map(oldSessions.map(s => [s.username, s]))

        // 一次快照可能包含大量会话变化。先在内存中筛选，避免为每个会话
        // 查询联系人并反复创建通知窗口。突发更新只显示最近的一条。
        const changedSessions = newSessions.filter(newSession => {
            const oldSession = oldMap.get(newSession.username)
            if (newSession.username === useChatStore.getState().currentSessionId) return false
            if (oldSession && newSession.lastTimestamp <= oldSession.lastTimestamp) return false
            if (newSession.isMuted || newSession.isFolded) return false
            if (newSession.username.toLowerCase().includes('placeholder_foldgroup')) return false
            if (newSession.unreadCount <= (oldSession?.unreadCount ?? 0)) return false

            return !isOwnGroupMessage(newSession)
        }).sort((a, b) => b.lastTimestamp - a.lastTimestamp)
        const isBurst = changedSessions.length > 1
        const notifications = changedSessions.slice(0, MAX_NOTIFICATION_CANDIDATES_PER_REFRESH)

        for (const newSession of notifications) {
            // 如果系统在通知联系人信息查询期间进入睡眠并恢复，停止当前补发循环。
            if (Date.now() < notificationQuietUntilRef.current) return

            const oldSession = oldMap.get(newSession.username)

            // 条件: 新会话或时间戳更新
            const isCurrentSession = newSession.username === useChatStore.getState().currentSessionId

            if (!isCurrentSession && (!oldSession || newSession.lastTimestamp > oldSession.lastTimestamp)) {
                // 这是新消息事件

                // 免打扰、折叠群、折叠入口不弹通知
                if (newSession.isMuted || newSession.isFolded) continue
                if (newSession.username.toLowerCase().includes('placeholder_foldgroup')) continue

                let title = displayNameOrFallback(newSession.username, newSession.displayName)
                let avatarUrl = newSession.avatarUrl
                let content = newSession.summary || '[新消息]'

                if (newSession.username.includes('@chatroom')) {
                    const lastSenderDisplayName = pickDisplayName(newSession.lastSenderDisplayName)
                    if (lastSenderDisplayName) {
                        content = `${lastSenderDisplayName}: ${content}`
                    }
                }

                // 修复 "Random User" 的逻辑 (缺少具体信息)
                // 如果标题看起来像 wxid 或没有头像，尝试获取信息
                const needsEnrichment = !pickDisplayName(newSession.displayName) || !newSession.avatarUrl || newSession.displayName === newSession.username

                if (needsEnrichment && newSession.username) {
                    try {
                        // 尝试丰富或获取联系人详情
                        const contact = await window.electronAPI.chat.getContact(newSession.username)
                        if (contact) {
                            const contactDisplayName = pickDisplayName(contact.remark, contact.nickName)
                            if (contactDisplayName) {
                                title = contactDisplayName
                            }
                            const avatarResult = await window.electronAPI.chat.getContactAvatar(newSession.username)
                            if (avatarResult?.avatarUrl) {
                                avatarUrl = avatarResult.avatarUrl
                            }
                        } else {
                            // 如果不在缓存/数据库中
                            const enrichResult = await window.electronAPI.chat.enrichSessionsContactInfo([newSession.username])
                            if (enrichResult.success && enrichResult.contacts) {
                                const enrichedContact = enrichResult.contacts[newSession.username]
                                if (enrichedContact) {
                                    const enrichedDisplayName = pickDisplayName(enrichedContact.displayName)
                                    if (enrichedDisplayName) {
                                        title = enrichedDisplayName
                                    }
                                    if (enrichedContact.avatarUrl) {
                                        avatarUrl = enrichedContact.avatarUrl
                                    }
                                }
                            }
                            // 如果仍然没有有效名称，再尝试一次获取
                            if (title === newSession.username || title.startsWith('wxid_')) {
                                const retried = await window.electronAPI.chat.getContact(newSession.username)
                                if (retried) {
                                    title = displayNameOrFallback(title, retried.remark, retried.nickName)
                                    const retriedAvatar = await window.electronAPI.chat.getContactAvatar(newSession.username)
                                    if (retriedAvatar?.avatarUrl) {
                                        avatarUrl = retriedAvatar.avatarUrl
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('获取通知的联系人信息失败', e)
                    }
                }

                // 最终检查：如果标题仍是 wxid 格式，则跳过通知（避免显示乱跳用户）
                // 群聊例外，因为群聊 username 包含 @chatroom
                const isGroupChat = newSession.username.includes('@chatroom')
                const isWxidTitle = title.startsWith('wxid_') && title === newSession.username
                if (isWxidTitle && !isGroupChat) {
                    console.warn('[NotificationFilter] 跳过无法识别的用户通知:', newSession.username)
                    continue
                }

                if (Date.now() < notificationQuietUntilRef.current) return

                // 调用 IPC 以显示独立窗口通知
                window.electronAPI.notification?.show({
                    title: title,
                    content: isBurst ? `${content}（另有会话更新）` : content,
                    avatarUrl: avatarUrl,
                    sessionId: newSession.username
                })

                // 通知窗口一次只能呈现一条。其他会话已进入列表，避免弹窗连发。
                break
            }
        }
    }

    const handleActiveSessionRefresh = async (sessionId: string) => {
        // 从 ChatPage 复制/调整的逻辑，以保持集中
        const state = useChatStore.getState()
        const msgs = state.messages || []
        const lastMsg = msgs[msgs.length - 1]
        const minTime = lastMsg?.createTime || 0

        try {
            const cursor = buildNewMessagesCursor(lastMsg)
            const result = await window.electronAPI.chat.getNewMessages(
                sessionId,
                Math.max(0, minTime - 1),
                120,
                cursor
            )
            if (result.success && result.messages && result.messages.length > 0) {
                const latestMessages = useChatStore.getState().messages || []
                const existingKeys = new Set(latestMessages.map(getMessageKey))
                const newMessages = result.messages.filter((msg: Message) => !existingKeys.has(getMessageKey(msg)))
                if (newMessages.length > 0) {
                    appendMessages(newMessages, false)
                }
            }
        } catch (e) {
            console.warn('后台活跃会话刷新失败:', e)
        }
    }

    // 此组件不再渲染 UI
    return null
}
