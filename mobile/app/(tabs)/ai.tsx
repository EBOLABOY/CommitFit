import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Pressable,
  Image,
  ActivityIndicator,
  Modal,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import Toast from 'react-native-toast-message';
import * as Haptics from 'expo-haptics';
import Animated, {
  FadeIn,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withDelay,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, getToken, streamOrchestrateChat } from '../../services/api';
import { AI_ROLES, Spacing, Radius, FontSize, API_BASE_URL, Shadows, HitSlop } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';
import type { OrchestrateAutoWriteSummary, SSERoutingEvent, SSESupplementEvent, AIRole } from '../../../shared/types';

interface LocalMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  image?: string;
  isStreaming?: boolean;
  primaryRole?: AIRole;
  supplements?: SSESupplementEvent[];
  routingInfo?: SSERoutingEvent;
}

const MAX_IMAGE_DIMENSION = 1600;
const INLINE_THRESHOLD = 500 * 1024;
const MAX_RETRY = 2;
const BASE_BACKOFF_MS = 600;

const MESSAGE_IMAGE_WIDTH = Math.min(Dimensions.get('window').width * 0.58, 280);

const SUGGESTIONS = [
  '左膝疼，深蹲时加重，怎么处理？',
  '帮我分析一下这张餐食图片',
  '最近睡眠差、心率偏高，该怎么调？',
  '帮我制定本周训练计划',
];

function getRoleColor(role: AIRole): string {
  return AI_ROLES[role as keyof typeof AI_ROLES]?.color || '#F39C12';
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(err: Error) {
  const msg = (err.message || '').toLowerCase();
  if (!msg) return true;
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden')) return false;
  if (msg.includes('400') || msg.includes('422') || msg.includes('参数') || msg.includes('请求体')) return false;
  return true;
}

// Animated pulsing dot
function PulsingDot({ color, delay: delayMs }: { color: string; delay: number }) {
  const opacity = useSharedValue(0.3);

  useEffect(() => {
    opacity.value = withDelay(
      delayMs,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 400 }),
          withTiming(0.3, { duration: 400 })
        ),
        -1
      )
    );
  }, [delayMs, opacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return <Animated.View style={[styles.dot, { backgroundColor: color }, animatedStyle]} />;
}

export default function AIChatScreen() {
  const Colors = useThemeColor();
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [input, setInput] = useState('');
  const [pendingImage, setPendingImage] = useState<{ uri: string; base64: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [retryMeta, setRetryMeta] = useState({ active: false, attempt: 0, delayMs: 0 });
  const [streamStatus, setStreamStatus] = useState('');
  const [writebackSummary, setWritebackSummary] = useState<OrchestrateAutoWriteSummary | null>(null);
  const [writebackError, setWritebackError] = useState('');
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [routingInfo, setRoutingInfo] = useState<SSERoutingEvent | null>(null);
  const [supplements, setSupplements] = useState<SSESupplementEvent[]>([]);
  const [token, setTokenState] = useState<string | null>(null);
  const flatListRef = useRef<FlatList>(null);
  const retryCountRef = useRef<Record<string, number>>({});
  const abortRef = useRef(false);

  useEffect(() => {
    getToken().then(setTokenState);
  }, []);

  // Load history on mount
  useEffect(() => {
    void (async () => {
      try {
        const res = await api.getOrchestrateHistory();
        if (res.success && res.data?.messages) {
          setMessages(
            res.data.messages.map((item) => {
              const msg: LocalMessage = {
                id: item.id,
                role: item.message_role,
                content: item.content,
                image: item.image_url || undefined,
              };
              // Parse metadata for assistant messages
              if (item.message_role === 'assistant' && (item as Record<string, unknown>).metadata) {
                try {
                  const raw = (item as Record<string, unknown>).metadata;
                  const meta = typeof raw === 'string' ? JSON.parse(raw) : raw;
                  if (meta && typeof meta === 'object') {
                    msg.primaryRole = meta.primary_role;
                    if (Array.isArray(meta.supplements)) {
                      msg.supplements = meta.supplements.map((s: { role: string; content: string }) => ({
                        role: s.role as AIRole,
                        role_name: AI_ROLES[s.role as keyof typeof AI_ROLES]?.name || s.role,
                        content: s.content,
                      }));
                    }
                    if (meta.primary_role) {
                      msg.routingInfo = {
                        primary_role: meta.primary_role,
                        primary_role_name: AI_ROLES[meta.primary_role as keyof typeof AI_ROLES]?.name || meta.primary_role,
                        collaborators: Array.isArray(meta.collaborators)
                          ? meta.collaborators.map((r: string) => ({
                              role: r as AIRole,
                              role_name: AI_ROLES[r as keyof typeof AI_ROLES]?.name || r,
                            }))
                          : [],
                        reason: meta.routing_reason || '',
                      };
                    }
                  }
                } catch {
                  // ignore metadata parse failure
                }
              }
              return msg;
            })
          );
        }
      } catch {
        // silently fail
      } finally {
        setHistoryLoading(false);
      }
    })();
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages]);

  const mdStyles = useMemo(() => ({
    body: { color: Colors.text, fontSize: FontSize.md, lineHeight: 24 },
    heading1: { color: Colors.text, fontSize: FontSize.xl, fontWeight: '700' as const, marginTop: 12, marginBottom: 6 },
    heading2: { color: Colors.text, fontSize: FontSize.lg, fontWeight: '700' as const, marginTop: 10, marginBottom: 4 },
    heading3: { color: Colors.text, fontSize: FontSize.md, fontWeight: '700' as const, marginTop: 8, marginBottom: 4 },
    paragraph: { color: Colors.text, fontSize: FontSize.md, lineHeight: 24, marginTop: 0, marginBottom: 8 },
    strong: { fontWeight: '700' as const },
    em: { fontStyle: 'italic' as const },
    bullet_list: { marginVertical: 4 },
    ordered_list: { marginVertical: 4 },
    list_item: { marginVertical: 2 },
    code_inline: {
      backgroundColor: Colors.background,
      color: Colors.danger,
      fontSize: FontSize.sm,
      paddingHorizontal: 4,
      paddingVertical: 1,
      borderRadius: 4,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    fence: {
      backgroundColor: Colors.background,
      borderRadius: Radius.sm,
      padding: Spacing.md,
      marginVertical: 8,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      fontSize: FontSize.sm,
      color: Colors.text,
    },
    blockquote: {
      backgroundColor: Colors.background,
      borderLeftWidth: 3,
      borderLeftColor: Colors.primary,
      paddingLeft: Spacing.md,
      paddingVertical: 4,
      marginVertical: 8,
    },
    hr: { backgroundColor: Colors.border, height: 1, marginVertical: 12 },
    table: { borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.sm, marginVertical: 8 },
    thead: { backgroundColor: Colors.background },
    th: { padding: 6, borderWidth: 0.5, borderColor: Colors.border, fontWeight: '600' as const },
    td: { padding: 6, borderWidth: 0.5, borderColor: Colors.border },
  }), [Colors]);

  const isErrorMessage = (content?: string) => !!content && content.startsWith('[错误]');
  const formatErrorText = (content: string) => content.replace(/^\[错误\]\s*/, '').trim();

  const getImageSource = useCallback((image: string) => {
    if (image.startsWith('file:') || image.startsWith('content:')) return { uri: image };
    const uri = `${API_BASE_URL}/api/images/${image}`;
    return token ? { uri, headers: { Authorization: `Bearer ${token}` } } : { uri };
  }, [token]);

  const resizeImage = async (uri: string): Promise<{ uri: string; base64: string } | null> => {
    try {
      const result = await manipulateAsync(
        uri,
        [{ resize: { width: MAX_IMAGE_DIMENSION } }],
        { compress: 0.7, format: SaveFormat.JPEG, base64: true }
      );
      if (!result.base64) return null;
      return { uri: result.uri, base64: result.base64 };
    } catch {
      return null;
    }
  };

  const handlePickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Toast.show({ type: 'error', text1: '权限不足', text2: '需要相册访问权限' });
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    if (!result.canceled && result.assets[0]) {
      const data = await resizeImage(result.assets[0].uri);
      if (data) setPendingImage(data);
    }
  };

  const handleTakePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Toast.show({ type: 'error', text1: '权限不足', text2: '需要相机权限' });
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
    if (!result.canceled && result.assets[0]) {
      const data = await resizeImage(result.assets[0].uri);
      if (data) setPendingImage(data);
    }
  };

  const handleImageButton = () => {
    Alert.alert('添加图片', '选择图片来源', [
      { text: '拍照', onPress: handleTakePhoto },
      { text: '从相册选择', onPress: handlePickImage },
      { text: '取消', style: 'cancel' },
    ]);
  };

  const handleCopyMessage = async (content: string) => {
    if (!content || isErrorMessage(content)) return;
    await Clipboard.setStringAsync(content);
    Toast.show({ type: 'success', text1: '已复制到剪贴板' });
  };

  const normalizeAdviceLine = (line: string) =>
    line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*•]\s+/, '')
      .replace(/^\d+[.)、]\s+/, '')
      .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();

  const handleCopyStructuredAdvice = async (content: string) => {
    if (!content || isErrorMessage(content)) return;
    const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const bullets = lines
      .filter((l) => /^[-*•]\s+/.test(l) || /^\d+[.)、]\s+/.test(l) || /^#{1,6}\s+/.test(l))
      .map(normalizeAdviceLine);
    const unique = [...new Set(bullets.map((b) => b.toLowerCase()))].map(
      (key) => bullets.find((b) => b.toLowerCase() === key)!
    ).slice(0, 8);
    const text = unique.length > 0
      ? unique.map((l, i) => `${i + 1}. ${l}`).join('\n')
      : normalizeAdviceLine(content);
    await Clipboard.setStringAsync(text);
    Toast.show({ type: 'success', text1: '结构化建议已复制' });
  };

  const handleSend = useCallback(async (presetText?: string) => {
    if (loading) return;
    const text = (presetText ?? input).trim() || (pendingImage ? '请帮我分析这张图片' : '');
    if (!text) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    abortRef.current = false;
    setStreamStatus('');
    setWritebackSummary(null);
    setWritebackError('');
    setRoutingInfo(null);
    setSupplements([]);

    const image = pendingImage;
    const now = Date.now();
    const userMessage: LocalMessage = { id: `${now}-user`, role: 'user', content: text, image: image?.uri };
    const assistantId = `${now}-assistant`;
    const assistantPlaceholder: LocalMessage = { id: assistantId, role: 'assistant', content: '', isStreaming: true };

    setMessages((prev) => [...prev, userMessage, assistantPlaceholder]);
    setInput('');
    setPendingImage(null);
    setLoading(true);
    setRetryMeta({ active: false, attempt: 0, delayMs: 0 });

    // Prepare image option
    let imageOption: { inline: string } | { key: string } | undefined;
    if (image) {
      if (image.base64.length < INLINE_THRESHOLD) {
        imageOption = { inline: `data:image/jpeg;base64,${image.base64}` };
      } else {
        try {
          const uploadRes = await api.uploadImage(image.uri);
          if (uploadRes.success && uploadRes.data?.key) {
            imageOption = { key: uploadRes.data.key };
          } else {
            imageOption = { inline: `data:image/jpeg;base64,${image.base64}` };
          }
        } catch {
          imageOption = { inline: `data:image/jpeg;base64,${image.base64}` };
        }
      }
    }

    // Build history payload (last 12 messages, excluding the just-added ones)
    const historyPayload = messages.slice(-12).map((m) => ({ role: m.role, content: m.content }));

    let finalError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRY; attempt += 1) {
      if (abortRef.current) break;

      if (attempt > 0) {
        const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1);
        setRetryMeta({ active: true, attempt, delayMs: delay });
        setStreamStatus('');
        setMessages((prev) =>
          prev.map((m) => m.id === assistantId ? { ...m, content: '', isStreaming: true } : m)
        );
        await sleep(delay);
      }

      const error = await new Promise<Error | null>((resolve) => {
        streamOrchestrateChat(
          text,
          historyPayload,
          {
            onChunk: (chunk) => {
              setMessages((prev) =>
                prev.map((m) => m.id === assistantId ? { ...m, content: m.content + chunk } : m)
              );
            },
            onDone: () => resolve(null),
            onError: (err) => resolve(err instanceof Error ? err : new Error('请求失败，请重试')),
            onStatus: (status) => setStreamStatus(status),
            onRouting: (routing) => setRoutingInfo(routing),
            onSupplement: (supplement) => setSupplements((prev) => [...prev, supplement]),
            onWriteback: (summary) => {
              setWritebackSummary(summary);
              setWritebackError('');
            },
            onWritebackError: (errorMessage) => setWritebackError(errorMessage),
          },
          imageOption,
        );
      });

      if (!error) {
        setRetryMeta({ active: false, attempt: 0, delayMs: 0 });
        setStreamStatus('');
        setMessages((prev) =>
          prev.map((m) => m.id === assistantId ? {
            ...m,
            isStreaming: false,
            primaryRole: routingInfo?.primary_role,
            routingInfo: routingInfo || undefined,
            supplements: supplements.length > 0 ? supplements : undefined,
          } : m)
        );
        setLoading(false);
        return;
      }

      finalError = error;
      if (attempt < MAX_RETRY && shouldRetry(error)) continue;
      break;
    }

    // All retries failed — show error in message + Toast
    const errorMsg = finalError?.message || '请求失败，请重试';
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantId
          ? { ...m, content: `[错误] ${errorMsg}`, isStreaming: false }
          : m
      )
    );
    setRetryMeta({ active: false, attempt: 0, delayMs: 0 });
    setStreamStatus('');
    setWritebackError('');
    setLoading(false);
    Toast.show({ type: 'error', text1: '请求失败', text2: errorMsg });
  }, [loading, input, pendingImage, messages]);

  const writebackText = useMemo(() => {
    if (!writebackSummary) return '';
    const tags: string[] = [];
    if (writebackSummary.profile_updated) tags.push('身体档案');
    if (writebackSummary.conditions_upserted > 0) tags.push(`伤病记录 ${writebackSummary.conditions_upserted} 条`);
    if (writebackSummary.training_goals_upserted > 0) tags.push(`训练目标 ${writebackSummary.training_goals_upserted} 条`);
    if (writebackSummary.health_metrics_created > 0) tags.push(`理化指标 ${writebackSummary.health_metrics_created} 条`);
    if (writebackSummary.nutrition_plan_created) tags.push('营养方案');
    if (writebackSummary.supplement_plan_created) tags.push('补剂方案');
    if (writebackSummary.daily_log_upserted) tags.push('体重/睡眠日志');
    return tags.length > 0 ? `已同步：${tags.join('、')}` : '未识别到可写回数据';
  }, [writebackSummary]);

  const findPreviousUserMessage = (startIndex: number) => {
    for (let i = startIndex - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'user') return messages[i];
    }
    return null;
  };

  const retryFromIndex = (startIndex: number) => {
    const previousUserMessage = findPreviousUserMessage(startIndex);
    if (!previousUserMessage?.content?.trim()) {
      Toast.show({ type: 'error', text1: '无法重试', text2: '未找到对应的用户提问' });
      return;
    }

    const retryKey = previousUserMessage.id;
    const nextCount = (retryCountRef.current[retryKey] || 0) + 1;
    retryCountRef.current[retryKey] = nextCount;
    const delay = Math.min(500 * 2 ** (nextCount - 1), 4000);

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (delay >= 800) {
      Toast.show({ type: 'info', text1: '正在重试', text2: `${Math.round(delay / 1000)} 秒后发送（第 ${nextCount} 次）` });
    }

    setTimeout(() => {
      void handleSend(previousUserMessage.content);
    }, delay);
  };

  const lastFailedIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant' && isErrorMessage(messages[i].content)) return i;
    }
    return -1;
  }, [messages]);

  const lastErrorText = useMemo(() => {
    if (lastFailedIndex < 0) return '';
    return formatErrorText(messages[lastFailedIndex].content);
  }, [lastFailedIndex, messages]);

  const handleClear = () => {
    Alert.alert('清空对话', '确定要清空所有对话记录吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: async () => {
          await api.clearOrchestrateHistory();
          setMessages([]);
          Toast.show({ type: 'success', text1: '已清空对话' });
        },
      },
    ]);
  };

  // Show loading spinner while history is loading
  if (historyLoading) {
    return (
      <View style={[styles.container, styles.centerContent, { backgroundColor: Colors.background, paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: Colors.background, paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      {messages.length === 0 ? (
        <View style={styles.emptyState}>
          <View style={[styles.emptyIcon, { backgroundColor: Colors.primaryLight }]}>
            <Ionicons name="chatbubbles" size={40} color={Colors.primary} />
          </View>
          <Text style={[styles.emptyTitle, { color: Colors.text }]}>有什么可以帮你？</Text>
          <View style={styles.suggestionsWrap}>
            {SUGGESTIONS.map((suggestion, index) => (
              <TouchableOpacity
                key={index}
                style={[styles.suggestionChip, { borderColor: Colors.border, backgroundColor: Colors.surface }]}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  void handleSend(suggestion);
                }}
                activeOpacity={0.7}
              >
                <Text style={[styles.suggestionText, { color: Colors.text }]}>{suggestion}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ) : (
        <View style={styles.chatBody}>
          {/* Header with clear button */}
          <View style={[styles.chatHeader, { borderBottomColor: Colors.borderLight }]}>
            <Text style={[styles.chatHeaderTitle, { color: Colors.text }]}>AI 咨询</Text>
            <TouchableOpacity onPress={handleClear} hitSlop={HitSlop.md}>
              <Ionicons name="trash-outline" size={20} color={Colors.textTertiary} />
            </TouchableOpacity>
          </View>

          <FlatList
            ref={flatListRef}
            data={messages}
            extraData={streamStatus}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.messageList}
            renderItem={({ item, index }) => (
              <Animated.View entering={FadeIn.duration(260)}>
                <Pressable
                  onLongPress={() => handleCopyMessage(item.content)}
                  style={[
                    styles.messageBubble,
                    item.role === 'user'
                      ? [styles.userBubble, { backgroundColor: Colors.primary }]
                      : [styles.assistantBubble, { backgroundColor: Colors.surface }],
                  ]}
                >
                  {/* Routing chip — shown above assistant content */}
                  {item.role === 'assistant' && item.routingInfo && (
                    <View style={styles.routingChipRow}>
                      <View style={[styles.routingDot, { backgroundColor: getRoleColor(item.routingInfo.primary_role) }]} />
                      <Text style={[styles.routingChipText, { color: Colors.textSecondary }]}>
                        {item.routingInfo.primary_role_name}
                        {item.routingInfo.collaborators.length > 0
                          ? ` + ${item.routingInfo.collaborators.map((col: { role: AIRole; role_name: string }) => col.role_name).join('、')}`
                          : ''}
                      </Text>
                    </View>
                  )}
                  {/* Live routing indicator during streaming */}
                  {item.role === 'assistant' && item.isStreaming && !item.routingInfo && routingInfo && (
                    <View style={styles.routingChipRow}>
                      <View style={[styles.routingDot, { backgroundColor: getRoleColor(routingInfo.primary_role) }]} />
                      <Text style={[styles.routingChipText, { color: Colors.textSecondary }]}>
                        {routingInfo.primary_role_name}
                        {routingInfo.collaborators.length > 0
                          ? ` + ${routingInfo.collaborators.map((col: { role: AIRole; role_name: string }) => col.role_name).join('、')}`
                          : ''}
                      </Text>
                    </View>
                  )}
                  {item.image && (
                    <TouchableOpacity activeOpacity={0.85} onPress={() => setPreviewImage(item.image!)}>
                      <Image source={getImageSource(item.image)} style={styles.messageImage} resizeMode="cover" />
                    </TouchableOpacity>
                  )}
                  {item.role === 'user' ? (
                    <Text style={[styles.messageText, styles.userText]}>{item.content}</Text>
                  ) : item.content ? (
                    <View>
                      <Markdown style={mdStyles}>{item.content}</Markdown>
                      {item.isStreaming && !!streamStatus && (
                        <Text style={[styles.statusText, { color: Colors.textSecondary }]}>
                          {streamStatus}
                        </Text>
                      )}
                    </View>
                  ) : item.isStreaming ? (
                    <View style={styles.typingRow}>
                      <PulsingDot color={Colors.primary} delay={0} />
                      <PulsingDot color={Colors.primary} delay={160} />
                      <PulsingDot color={Colors.primary} delay={320} />
                      {!!streamStatus && (
                        <Text style={[styles.statusText, { color: Colors.textSecondary }]}>{streamStatus}</Text>
                      )}
                    </View>
                  ) : null}
                  {item.role === 'assistant' && !!item.content && !item.isStreaming && !isErrorMessage(item.content) && (
                    <TouchableOpacity
                      style={[styles.copyButton, { borderColor: Colors.primary + '45' }]}
                      onPress={() => handleCopyStructuredAdvice(item.content)}
                    >
                      <Ionicons name="copy-outline" size={14} color={Colors.primary} />
                      <Text style={[styles.copyButtonText, { color: Colors.primary }]}>复制建议</Text>
                    </TouchableOpacity>
                  )}
                  {item.role === 'assistant' && isErrorMessage(item.content) && (
                    <TouchableOpacity
                      style={[styles.retryButton, { borderColor: Colors.danger + '40' }]}
                      onPress={() => retryFromIndex(index)}
                    >
                      <Ionicons name="refresh" size={14} color={Colors.danger} />
                      <Text style={[styles.retryButtonText, { color: Colors.danger }]}>重试本条</Text>
                    </TouchableOpacity>
                  )}
                </Pressable>
                {/* Supplement cards — rendered after the assistant bubble */}
                {item.role === 'assistant' && !item.isStreaming && item.supplements && item.supplements.length > 0 && (
                  <View style={styles.supplementsContainer}>
                    {item.supplements.map((sup: SSESupplementEvent, supIdx: number) => (
                      <View
                        key={`${item.id}-sup-${supIdx}`}
                        style={[
                          styles.supplementCard,
                          {
                            backgroundColor: Colors.surface,
                            borderLeftColor: getRoleColor(sup.role),
                          },
                        ]}
                      >
                        <Text style={[styles.supplementTitle, { color: getRoleColor(sup.role) }]}>
                          {sup.role_name} 补充
                        </Text>
                        <Markdown style={mdStyles}>{sup.content}</Markdown>
                      </View>
                    ))}
                  </View>
                )}
                {/* Live supplement cards during streaming */}
                {item.role === 'assistant' && item.isStreaming && supplements.length > 0 && (
                  <View style={styles.supplementsContainer}>
                    {supplements.map((sup: SSESupplementEvent, supIdx: number) => (
                      <View
                        key={`live-sup-${supIdx}`}
                        style={[
                          styles.supplementCard,
                          {
                            backgroundColor: Colors.surface,
                            borderLeftColor: getRoleColor(sup.role),
                          },
                        ]}
                      >
                        <Text style={[styles.supplementTitle, { color: getRoleColor(sup.role) }]}>
                          {sup.role_name} 补充
                        </Text>
                        <Markdown style={mdStyles}>{sup.content}</Markdown>
                      </View>
                    ))}
                  </View>
                )}
              </Animated.View>
            )}
          />
        </View>
      )}

      {/* Error banner */}
      {lastFailedIndex >= 0 && !loading && (
        <View style={[styles.errorBanner, { backgroundColor: Colors.dangerLight, borderColor: Colors.danger + '40' }]}>
          <Ionicons name="alert-circle-outline" size={16} color={Colors.danger} />
          <Text style={[styles.errorBannerText, { color: Colors.danger }]} numberOfLines={2}>
            {lastErrorText || '上一次请求失败'}
          </Text>
          <TouchableOpacity onPress={() => retryFromIndex(lastFailedIndex)} style={styles.errorBannerAction}>
            <Text style={[styles.errorBannerActionText, { color: Colors.danger }]}>重试</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Retry banner */}
      {retryMeta.active && loading && (
        <View style={[styles.retryBanner, { backgroundColor: Colors.warningLight, borderColor: Colors.warning + '40' }]}>
          <Ionicons name="sync-outline" size={16} color={Colors.warning} />
          <Text style={[styles.retryBannerText, { color: Colors.warning }]}>
            网络波动，正在第 {retryMeta.attempt} 次重试（约 {Math.max(1, Math.round(retryMeta.delayMs / 1000))} 秒）
          </Text>
        </View>
      )}

      {/* Writeback banner */}
      {!!writebackText && !loading && (
        <View style={[styles.writebackBanner, { backgroundColor: Colors.successLight, borderColor: Colors.success + '40' }]}>
          <Ionicons name="save-outline" size={16} color={Colors.success} />
          <Text style={[styles.writebackBannerText, { color: Colors.success }]} numberOfLines={2}>
            {writebackText}
          </Text>
        </View>
      )}

      {!!writebackError && !loading && (
        <View style={[styles.writebackErrorBanner, { backgroundColor: Colors.dangerLight, borderColor: Colors.danger + '40' }]}>
          <Ionicons name="warning-outline" size={16} color={Colors.danger} />
          <Text style={[styles.writebackErrorBannerText, { color: Colors.danger }]} numberOfLines={2}>
            档案同步失败：{writebackError}
          </Text>
        </View>
      )}

      {/* Pending image preview */}
      {pendingImage && (
        <View style={[styles.previewBar, { backgroundColor: Colors.surface, borderTopColor: Colors.borderLight }]}>
          <Image source={{ uri: pendingImage.uri }} style={styles.previewImage} resizeMode="cover" />
          <TouchableOpacity style={styles.previewRemove} onPress={() => setPendingImage(null)}>
            <Ionicons name="close-circle" size={22} color={Colors.danger} />
          </TouchableOpacity>
        </View>
      )}

      {/* Input bar */}
      <View style={[styles.inputContainer, { backgroundColor: Colors.surface, borderTopColor: Colors.borderLight }]}>
        <TouchableOpacity style={styles.imageButton} onPress={handleImageButton} disabled={loading}>
          <Ionicons name="image-outline" size={24} color={loading ? Colors.disabled : Colors.primary} />
        </TouchableOpacity>
        <TextInput
          style={[styles.input, { backgroundColor: Colors.background, color: Colors.text }]}
          placeholder={pendingImage ? '描述一下这张图片...' : '输入你的问题...'}
          placeholderTextColor={Colors.textTertiary}
          value={input}
          onChangeText={setInput}
          multiline
          maxLength={2000}
          editable={!loading}
        />
        <TouchableOpacity
          style={[styles.sendButton, { backgroundColor: (input.trim() || pendingImage) && !loading ? Colors.primary : Colors.disabled }]}
          onPress={() => void handleSend()}
          disabled={loading || (!input.trim() && !pendingImage)}
        >
          <Ionicons name="arrow-up" size={20} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      {/* Full-screen image preview */}
      <Modal visible={!!previewImage} transparent animationType="fade" onRequestClose={() => setPreviewImage(null)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            style={[styles.modalCloseButton, { top: insets.top + 12 }]}
            onPress={() => setPreviewImage(null)}
            hitSlop={HitSlop.md}
          >
            <Ionicons name="close" size={26} color="#FFFFFF" />
          </TouchableOpacity>
          {previewImage && (
            <Image
              source={getImageSource(previewImage)}
              style={styles.modalImage}
              resizeMode="contain"
            />
          )}
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centerContent: { justifyContent: 'center', alignItems: 'center' },

  // Empty state
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: Spacing.xl },
  emptyIcon: {
    width: 88,
    height: 88,
    borderRadius: Radius.full,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.xl,
  },
  emptyTitle: { fontSize: FontSize.xl, fontWeight: '600', marginBottom: Spacing.xxl },
  suggestionsWrap: { width: '100%', gap: Spacing.sm },
  suggestionChip: {
    width: '100%',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: Radius.lg,
    borderWidth: 1,
    ...Shadows.sm,
  },
  suggestionText: { fontSize: FontSize.md, lineHeight: 22 },

  // Chat body
  chatBody: { flex: 1 },
  chatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
  },
  chatHeaderTitle: { fontSize: FontSize.lg, fontWeight: '700' },

  messageList: { padding: Spacing.lg, gap: Spacing.md, paddingBottom: 20 },
  messageBubble: { maxWidth: '90%', padding: Spacing.lg, borderRadius: Radius.lg },
  userBubble: { alignSelf: 'flex-end', borderBottomRightRadius: Radius.sm },
  assistantBubble: { alignSelf: 'flex-start', borderBottomLeftRadius: Radius.sm, ...Shadows.sm },
  messageText: { fontSize: FontSize.md, lineHeight: 24 },
  userText: { color: '#FFFFFF' },
  messageImage: {
    width: MESSAGE_IMAGE_WIDTH,
    height: MESSAGE_IMAGE_WIDTH * 0.75,
    borderRadius: Radius.md,
    marginBottom: Spacing.sm,
  },

  typingRow: { flexDirection: 'row', gap: Spacing.sm, paddingVertical: Spacing.xs },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: FontSize.xs, marginLeft: Spacing.sm },

  // Routing chip
  routingChipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    marginBottom: Spacing.sm,
  },
  routingDot: { width: 8, height: 8, borderRadius: 4 },
  routingChipText: { fontSize: FontSize.xs, fontWeight: '600' },

  // Supplement cards
  supplementsContainer: { marginLeft: Spacing.md, marginTop: Spacing.sm, gap: Spacing.sm },
  supplementCard: {
    borderLeftWidth: 3,
    borderRadius: Radius.md,
    padding: Spacing.md,
    maxWidth: '88%',
    ...Shadows.sm,
  },
  supplementTitle: { fontSize: FontSize.sm, fontWeight: '700', marginBottom: Spacing.xs },

  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    alignSelf: 'flex-start',
    marginTop: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  copyButtonText: { fontSize: FontSize.xs, fontWeight: '500' },

  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    alignSelf: 'flex-start',
    marginTop: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: Radius.full,
    borderWidth: 1,
  },
  retryButtonText: { fontSize: FontSize.xs, fontWeight: '500' },

  // Error banner
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    borderWidth: 1,
    borderRadius: Radius.md,
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
  },
  errorBannerText: { flex: 1, fontSize: FontSize.xs },
  errorBannerAction: { paddingHorizontal: Spacing.xs, paddingVertical: 2 },
  errorBannerActionText: { fontSize: FontSize.xs, fontWeight: '700' },

  // Retry banner
  retryBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    borderWidth: 1,
    borderRadius: Radius.md,
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
  },
  retryBannerText: { fontSize: FontSize.xs, flex: 1 },

  // Writeback banner
  writebackBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    borderWidth: 1,
    borderRadius: Radius.md,
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
  },
  writebackBannerText: { fontSize: FontSize.xs, flex: 1 },

  writebackErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    borderWidth: 1,
    borderRadius: Radius.md,
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.xs,
  },
  writebackErrorBannerText: { fontSize: FontSize.xs, flex: 1 },

  // Image preview
  previewBar: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm, borderTopWidth: 1 },
  previewImage: { width: 72, height: 72, borderRadius: Radius.md },
  previewRemove: { position: 'absolute', top: Spacing.xs, left: 68 },

  // Input
  inputContainer: {
    flexDirection: 'row',
    padding: Spacing.md,
    paddingBottom: Platform.OS === 'ios' ? Spacing.xxl : Spacing.md,
    borderTopWidth: 1,
    alignItems: 'flex-end',
    gap: Spacing.sm,
  },
  imageButton: { width: 38, height: 38, justifyContent: 'center', alignItems: 'center' },
  input: {
    flex: 1,
    borderRadius: Radius.xl,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    fontSize: FontSize.md,
    maxHeight: 100,
  },
  sendButton: { width: 38, height: 38, borderRadius: Radius.full, justifyContent: 'center', alignItems: 'center' },

  // Full-screen image modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.95)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCloseButton: {
    position: 'absolute',
    right: Spacing.lg,
    zIndex: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalImage: {
    width: '92%',
    height: '72%',
  },
});
