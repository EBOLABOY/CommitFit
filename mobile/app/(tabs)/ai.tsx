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
  Modal,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
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
import { api, getToken } from '../../services/api';
import { AI_ROLES, Spacing, Radius, FontSize, API_BASE_URL, Shadows, HitSlop } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';
import { useAgentChat } from '../../hooks/useAgentChat';
import type {
  OrchestrateAutoWriteSummary,
  SSERoutingEvent,
  SSESupplementEvent,
  AIRole,
} from '../../../shared/types';

const MAX_IMAGE_DIMENSION = 1600;
const INLINE_THRESHOLD = 500 * 1024;

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

  // WebSocket-based chat
  const {
    messages,
    isLoading,
    isConnected,
    error: wsError,
    streamStatus,
    routingInfo,
    supplements,
    writebackSummary,
    pendingApproval,
    sendMessage,
    approveToolCall,
    rejectToolCall,
    clearMessages,
  } = useAgentChat();

  const [input, setInput] = useState('');
  const [pendingImage, setPendingImage] = useState<{ uri: string; base64: string } | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [token, setTokenState] = useState<string | null>(null);
  // 排队消息：AI 回复期间用户发送的消息将暂存此处，待 AI 完成后自动触发
  const [queuedMessage, setQueuedMessage] = useState<{ text: string; imageDataUri?: string } | null>(null);
  const flatListRef = useRef<FlatList>(null);

  useEffect(() => {
    getToken().then(setTokenState);
  }, []);

  // AI 完成时，自动发送排队中的消息
  useEffect(() => {
    if (!isLoading && queuedMessage) {
      const { text, imageDataUri } = queuedMessage;
      setQueuedMessage(null);
      sendMessage(text, imageDataUri);
    }
  }, [isLoading, queuedMessage, sendMessage]);

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

  const getImageSource = useCallback((image: string) => {
    if (image.startsWith('file:') || image.startsWith('content:') || image.startsWith('data:')) return { uri: image };
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


  const handleSend = useCallback(async (presetText?: string) => {
    const text = (presetText ?? input).trim() || (pendingImage ? '请帮我分析这张图片' : '');
    if (!text) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // Prepare image data URI
    let imageDataUri: string | undefined;
    if (pendingImage) {
      if (pendingImage.base64.length < INLINE_THRESHOLD) {
        imageDataUri = `data:image/jpeg;base64,${pendingImage.base64}`;
      } else {
        try {
          const uploadRes = await api.uploadImage(pendingImage.uri);
          imageDataUri = uploadRes.success && uploadRes.data?.key
            ? `data:image/jpeg;base64,${pendingImage.base64}`
            : `data:image/jpeg;base64,${pendingImage.base64}`;
        } catch {
          imageDataUri = `data:image/jpeg;base64,${pendingImage.base64}`;
        }
      }
    }

    setInput('');
    setPendingImage(null);

    if (isLoading) {
      // Codex CLI 风格：AI 回复期间排队，待完成后自动发送
      setQueuedMessage({ text, imageDataUri });
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } else {
      sendMessage(text, imageDataUri);
    }
  }, [isLoading, input, pendingImage, sendMessage]);

  const writebackText = useMemo(() => {
    if (!writebackSummary) return '';
    const tags: string[] = [];
    if (writebackSummary.user_updated) tags.push('用户信息');
    if (writebackSummary.profile_updated) tags.push('身体档案');
    if (writebackSummary.conditions_upserted > 0) tags.push(`伤病记录 更新 ${writebackSummary.conditions_upserted} 条`);
    if ((writebackSummary.conditions_deleted || 0) > 0) tags.push(`伤病记录 删除 ${writebackSummary.conditions_deleted} 条`);
    if (writebackSummary.training_goals_upserted > 0) tags.push(`训练目标 更新 ${writebackSummary.training_goals_upserted} 条`);
    if ((writebackSummary.training_goals_deleted || 0) > 0) tags.push(`训练目标 删除 ${writebackSummary.training_goals_deleted} 条`);
    if (writebackSummary.health_metrics_created > 0) tags.push(`理化指标 新增 ${writebackSummary.health_metrics_created} 条`);
    if ((writebackSummary.health_metrics_updated || 0) > 0) tags.push(`理化指标 更新 ${writebackSummary.health_metrics_updated} 条`);
    if ((writebackSummary.health_metrics_deleted || 0) > 0) tags.push(`理化指标 删除 ${writebackSummary.health_metrics_deleted} 条`);
    if (writebackSummary.training_plan_created) tags.push('训练计划 已保存');
    if (writebackSummary.training_plan_deleted) tags.push('训练计划 已删除');
    if (writebackSummary.nutrition_plan_created) tags.push('饮食方案 已保存');
    if (writebackSummary.nutrition_plan_deleted) tags.push('饮食方案 已删除');
    if (writebackSummary.supplement_plan_created) tags.push('补剂方案 已保存');
    if (writebackSummary.supplement_plan_deleted) tags.push('补剂方案 已删除');
    if (writebackSummary.diet_records_created > 0) tags.push(`饮食记录 新增/更新 ${writebackSummary.diet_records_created} 条`);
    if ((writebackSummary.diet_records_deleted || 0) > 0) tags.push(`饮食记录 删除 ${writebackSummary.diet_records_deleted} 条`);
    if (writebackSummary.daily_log_upserted) tags.push('体重/睡眠日志 已保存');
    if (writebackSummary.daily_log_deleted) tags.push('体重/睡眠日志 已删除');
    return tags.length > 0 ? `已同步：${tags.join('、')}` : '';
  }, [writebackSummary]);

  const handleClear = () => {
    Alert.alert('清空对话', '确定要清空所有对话记录吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: () => {
          clearMessages();
          Toast.show({ type: 'success', text1: '已清空对话' });
        },
      },
    ]);
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: Colors.background, paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      {messages.length === 0 ? (
        <View style={styles.emptyState}>
          <View style={[styles.emptyIcon, { backgroundColor: Colors.primaryLight }]}>
            <Ionicons name="chatbubbles" size={40} color={Colors.primary} />
          </View>
          <Text style={[styles.emptyTitle, { color: Colors.text }]}>有什么可以帮你？</Text>
          {/* Connection status */}
          <View style={styles.connectionRow}>
            <View style={[styles.connectionDot, { backgroundColor: isConnected ? Colors.success : Colors.danger }]} />
            <Text style={[styles.connectionText, { color: Colors.textSecondary }]}>
              {isConnected ? '已连接' : '未连接'}
            </Text>
          </View>
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
                disabled={!isConnected}
              >
                <Text style={[styles.suggestionText, { color: Colors.text }]}>{suggestion}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ) : (
        <View style={styles.chatBody}>
          {/* Header with connection indicator + clear button */}
          <View style={[styles.chatHeader, { borderBottomColor: Colors.borderLight }]}>
            <View style={styles.chatHeaderLeft}>
              <View style={[styles.connectionDot, { backgroundColor: isConnected ? Colors.success : Colors.danger }]} />
              <Text style={[styles.chatHeaderTitle, { color: Colors.text }]}>AI 咨询</Text>
            </View>
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
             renderItem={({ item }) => (
               <Animated.View entering={FadeIn.duration(260)}>
                 <Pressable
                    style={[
                      styles.messageBubble,
                      item.role === 'user'
                        ? [styles.userBubble, { backgroundColor: Colors.primary }]
                      : [styles.assistantBubble, { backgroundColor: Colors.surface }],
                  ]}
                >
                  {/* Routing chip */}
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
                </Pressable>
                {/* Supplement cards */}
                {item.role === 'assistant' && !item.isStreaming && item.supplements && item.supplements.length > 0 && (
                  <View style={styles.supplementsContainer}>
                    {item.supplements.map((sup: SSESupplementEvent, supIdx: number) => (
                      <View
                        key={`${item.id}-sup-${supIdx}`}
                        style={[styles.supplementCard, { backgroundColor: Colors.surface, borderLeftColor: getRoleColor(sup.role) }]}
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
                        style={[styles.supplementCard, { backgroundColor: Colors.surface, borderLeftColor: getRoleColor(sup.role) }]}
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

      {/* WebSocket error banner */}
      {wsError && !isLoading && (
        <View style={[styles.errorBanner, { backgroundColor: Colors.dangerLight, borderColor: Colors.danger + '40' }]}>
          <Ionicons name="alert-circle-outline" size={16} color={Colors.danger} />
          <Text style={[styles.errorBannerText, { color: Colors.danger }]} numberOfLines={2}>
            {wsError}
          </Text>
        </View>
      )}

      {/* Writeback banner */}
      {!!writebackText && !isLoading && (
        <View style={[styles.writebackBanner, { backgroundColor: Colors.successLight, borderColor: Colors.success + '40' }]}>
          <Ionicons name="save-outline" size={16} color={Colors.success} />
          <Text style={[styles.writebackBannerText, { color: Colors.success }]} numberOfLines={2}>
            {writebackText}
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

      {/* 排队提示 Banner */}
      {!!queuedMessage && (
        <Pressable
          style={[styles.queueBanner, { backgroundColor: Colors.primaryLight, borderColor: Colors.primary + '40' }]}
          onPress={() => setQueuedMessage(null)}
        >
          <Ionicons name="time-outline" size={14} color={Colors.primary} />
          <Text style={[styles.queueBannerText, { color: Colors.primary }]} numberOfLines={1}>
            排队中：{queuedMessage.text}
          </Text>
          <Ionicons name="close-circle" size={16} color={Colors.primary} />
        </Pressable>
      )}

      {/* Input bar */}
      <View style={[styles.inputContainer, { backgroundColor: Colors.surface, borderTopColor: Colors.borderLight }]}>
        <TouchableOpacity style={styles.imageButton} onPress={handleImageButton} disabled={!!queuedMessage}>
          <Ionicons name="image-outline" size={24} color={queuedMessage ? Colors.disabled : Colors.primary} />
        </TouchableOpacity>
        <TextInput
          style={[styles.input, { backgroundColor: Colors.background, color: Colors.text }]}
          placeholder={
            queuedMessage ? '已排队，AI 完成后自动发送...' :
              pendingImage ? '描述一下这张图片...' : '输入你的问题...'
          }
          placeholderTextColor={Colors.textTertiary}
          value={input}
          onChangeText={setInput}
          multiline
          maxLength={2000}
          editable={!queuedMessage}
        />
        <TouchableOpacity
          style={[styles.sendButton, {
            backgroundColor:
              queuedMessage ? Colors.disabled :
                (input.trim() || pendingImage) && isConnected
                  ? isLoading ? Colors.warning ?? '#F39C12'
                    : Colors.primary
                  : Colors.disabled,
          }]}
          onPress={() => void handleSend()}
          disabled={!!queuedMessage || (!input.trim() && !pendingImage) || !isConnected}
        >
          <Ionicons
            name={isLoading && (input.trim() || !!pendingImage) ? 'hourglass-outline' : 'arrow-up'}
            size={20}
            color="#FFFFFF"
          />
        </TouchableOpacity>
      </View>

      {/* Tool Approval Modal */}
      <Modal visible={!!pendingApproval} transparent animationType="fade">
        <View style={styles.approvalOverlay}>
          <View style={[styles.approvalCard, { backgroundColor: Colors.surface }]}>
            <Text style={[styles.approvalTitle, { color: Colors.text }]}>确认同步数据？</Text>
            <Text style={[styles.approvalDescription, { color: Colors.textSecondary }]}>
              {pendingApproval?.summaryText || '是否将识别到的健康数据同步到你的档案？'}
            </Text>
            <View style={styles.approvalButtons}>
              <TouchableOpacity
                style={[styles.approvalButton, styles.approvalReject, { borderColor: Colors.border }]}
                onPress={() => pendingApproval && rejectToolCall(pendingApproval.toolCallId)}
              >
                <Text style={[styles.approvalButtonText, { color: Colors.textSecondary }]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.approvalButton, styles.approvalApprove, { backgroundColor: Colors.primary }]}
                onPress={() => {
                  if (pendingApproval) {
                    approveToolCall(pendingApproval.toolCallId);
                    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  }
                }}
              >
                <Text style={[styles.approvalButtonText, { color: '#FFFFFF' }]}>确认同步</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

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
  emptyTitle: { fontSize: FontSize.xl, fontWeight: '600', marginBottom: Spacing.sm },
  connectionRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, marginBottom: Spacing.xxl },
  connectionDot: { width: 8, height: 8, borderRadius: 4 },
  connectionText: { fontSize: FontSize.xs },
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
  chatHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
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

  // 排队中 Banner
  queueBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    borderWidth: 1,
    borderRadius: Radius.md,
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm,
  },
  queueBannerText: { flex: 1, fontSize: FontSize.xs, fontWeight: '500' },

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

  // Tool approval modal
  approvalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.xl,
  },
  approvalCard: {
    width: '100%',
    maxWidth: 360,
    borderRadius: Radius.xl,
    padding: Spacing.xxl,
    ...Shadows.lg,
  },
  approvalTitle: {
    fontSize: FontSize.lg,
    fontWeight: '700',
    marginBottom: Spacing.md,
    textAlign: 'center',
  },
  approvalDescription: {
    fontSize: FontSize.md,
    lineHeight: 22,
    marginBottom: Spacing.xxl,
    textAlign: 'center',
  },
  approvalButtons: { flexDirection: 'row', gap: Spacing.md },
  approvalButton: {
    flex: 1,
    paddingVertical: Spacing.md,
    borderRadius: Radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  approvalReject: { borderWidth: 1 },
  approvalApprove: {},
  approvalButtonText: { fontSize: FontSize.md, fontWeight: '600' },

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
