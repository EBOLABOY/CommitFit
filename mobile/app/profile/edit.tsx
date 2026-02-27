import { useMemo, useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Image,
  Pressable,
  TextInput,
  Modal,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as Haptics from 'expo-haptics';
import DateTimePicker from '@react-native-community/datetimepicker';
import Toast from 'react-native-toast-message';
import { api, getToken } from '../../services/api';
import { useAuthStore } from '../../stores/auth';
import { ProfileData } from '../../stores/profile';
import { Button, Card, LoadingScreen } from '../../components/ui';
import { API_BASE_URL, Spacing, Radius, FontSize, GENDER_LABELS, Gradients, Shadows } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';
import type { UpdateProfileRequest, Gender } from '@shared/types';

const MAX_AVATAR_DIMENSION = 640;

// 格式化时间辅助
function formatTrainingYears(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const isInt = Math.abs(rounded - Math.round(rounded)) < 1e-9;
  return isInt ? String(Math.round(rounded)) : rounded.toFixed(1);
}

// 提取一个无边框的极简输入行组件
function InlineInputRow({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = 'default',
  maxLength,
  isLast = false,
  hint,
}: any) {
  const Colors = useThemeColor();
  return (
    <View style={[styles.inlineRow, !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.borderLight }]}>
      <Text style={[styles.inlineLabel, { color: Colors.text }]}>{label}</Text>
      <View style={styles.inlineInputWrapper}>
        <TextInput
          style={[styles.inlineInput, { color: Colors.textSecondary }]}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={Colors.disabled}
          keyboardType={keyboardType}
          maxLength={maxLength}
          textAlign="right"
          selectionColor={Colors.primary}
        />
        {hint && (
          <Text style={[styles.inlineHint, { color: Colors.textTertiary }]}>{hint}</Text>
        )}
      </View>
    </View>
  );
}

// 提取一个展示用（触发日期选择等）的行组件
function InlinePressableRow({ label, value, placeholder, onPress, isLast = false }: any) {
  const Colors = useThemeColor();
  return (
    <Pressable
      style={[styles.inlineRow, !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.borderLight }]}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
    >
      <Text style={[styles.inlineLabel, { color: Colors.text }]}>{label}</Text>
      <View style={styles.inlineInputWrapper}>
        <Text style={[
          styles.inlineInputText,
          value ? { color: Colors.textSecondary } : { color: Colors.disabled }
        ]}>
          {value || placeholder}
        </Text>
      </View>
    </Pressable>
  );
}

// 提取极简的选项选择行组件
function InlineOptionRow({ label, options, selected, onSelect, isLast = false }: any) {
  const Colors = useThemeColor();
  return (
    <View style={[styles.inlineRow, !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.borderLight }]}>
      <Text style={[styles.inlineLabel, { color: Colors.text }]}>{label}</Text>
      <View style={styles.inlineOptions}>
        {options.map((opt: any) => {
          const isActive = selected === opt.value;
          return (
            <Pressable
              key={opt.value}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onSelect(opt.value);
              }}
              style={[
                styles.inlineOptionChip,
                isActive ? { backgroundColor: Colors.primary } : { backgroundColor: Colors.borderLight }
              ]}
            >
              <Text style={[
                styles.inlineOptionText,
                isActive ? { color: Colors.surface } : { color: Colors.textSecondary }
              ]}>{opt.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function EditProfileScreen() {
  const router = useRouter();
  const Colors = useThemeColor();
  const { setUser } = useAuthStore();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  // 初始状态，用于 Dirty Check
  const [initialMe, setInitialMe] = useState<{ nickname: string | null; avatar_key: string | null } | null>(null);
  const [initialProfile, setInitialProfile] = useState<ProfileData | null>(null);

  const [nickname, setNickname] = useState('');
  const [avatarKey, setAvatarKey] = useState<string | null>(null);
  const [pendingAvatarUri, setPendingAvatarUri] = useState<string | null>(null);

  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  // yyyy-mm-dd
  const [birthDate, setBirthDate] = useState('');
  const [gender, setGender] = useState<string | null>(null);
  // HH:mm（24小时制）
  const [trainingStartTime, setTrainingStartTime] = useState('');
  const [breakfastTime, setBreakfastTime] = useState('');
  const [lunchTime, setLunchTime] = useState('');
  const [dinnerTime, setDinnerTime] = useState('');
  const [trainingYears, setTrainingYears] = useState('');

  // 日期弹窗状态
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [activeTimeField, setActiveTimeField] = useState<'training' | 'breakfast' | 'lunch' | 'dinner' | null>(null);
  const [showTimePicker, setShowTimePicker] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [storedToken, meRes, profileRes] = await Promise.all([
          getToken(),
          api.getMe(),
          api.getProfile(),
        ]);

        setToken(storedToken);

        if (meRes.success && meRes.data) {
          const me = meRes.data as { nickname: string | null; avatar_key: string | null };
          setInitialMe(me);
          if (me.nickname) setNickname(me.nickname);
          setAvatarKey(me.avatar_key ?? null);
        }

        if (profileRes.success && profileRes.data) {
          const d = profileRes.data as ProfileData;
          setInitialProfile(d);
          if (d.height != null) setHeight(String(d.height));
          if (d.weight != null) setWeight(String(d.weight));
          if (d.birth_date) setBirthDate(String(d.birth_date));
          if (d.gender) setGender(d.gender);
          if (d.training_start_time != null) setTrainingStartTime(String(d.training_start_time));
          if (d.breakfast_time != null) setBreakfastTime(String(d.breakfast_time));
          if (d.lunch_time != null) setLunchTime(String(d.lunch_time));
          if (d.dinner_time != null) setDinnerTime(String(d.dinner_time));
          if (d.training_years != null) setTrainingYears(String(d.training_years));
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const avatarSource = useMemo(() => {
    if (pendingAvatarUri) return { uri: pendingAvatarUri };
    if (!avatarKey) return null;
    const uri = `${API_BASE_URL}/api/images/${avatarKey}`;
    return token ? { uri, headers: { Authorization: `Bearer ${token}` } } : { uri };
  }, [pendingAvatarUri, avatarKey, token]);

  const avatarInitial = useMemo(() => {
    const n = nickname.trim();
    if (n) return n.slice(0, 1);
    return '练';
  }, [nickname]);

  // 表单脏检查 (Dirty Check)
  const isDirty = useMemo(() => {
    if (pendingAvatarUri) return true;
    if (!initialMe || !initialProfile) return false;

    if ((nickname.trim() || null) !== initialMe.nickname) return true;
    if (avatarKey !== initialMe.avatar_key) return true;

    const hStr = initialProfile.height != null ? String(initialProfile.height) : '';
    if (height !== hStr) return true;

    const wStr = initialProfile.weight != null ? String(initialProfile.weight) : '';
    if (weight !== wStr) return true;

    const sStr = initialProfile.training_start_time != null ? String(initialProfile.training_start_time) : '';
    if (trainingStartTime !== sStr) return true;

    const bfStr = initialProfile.breakfast_time != null ? String(initialProfile.breakfast_time) : '';
    if (breakfastTime !== bfStr) return true;

    const lStr = initialProfile.lunch_time != null ? String(initialProfile.lunch_time) : '';
    if (lunchTime !== lStr) return true;

    const dStr = initialProfile.dinner_time != null ? String(initialProfile.dinner_time) : '';
    if (dinnerTime !== dStr) return true;

    const tStr = initialProfile.training_years != null ? String(initialProfile.training_years) : '';
    if (trainingYears !== tStr) return true;

    const bStr = initialProfile.birth_date || '';
    if (birthDate !== bStr) return true;

    const gStr = initialProfile.gender || null;
    if (gender !== gStr) return true;

    return false;
  }, [pendingAvatarUri, initialMe, initialProfile, nickname, avatarKey, height, weight, trainingStartTime, breakfastTime, lunchTime, dinnerTime, trainingYears, birthDate, gender]);

  const resizeAvatarIfNeeded = async (uri: string): Promise<string | null> => {
    try {
      const result = await manipulateAsync(
        uri,
        [{ resize: { width: MAX_AVATAR_DIMENSION } }],
        { compress: 0.8, format: SaveFormat.JPEG }
      );
      return result.uri;
    } catch {
      return null;
    }
  };

  const handlePickAvatar = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Toast.show({ type: 'error', text1: '权限不足', text2: '需要相册访问权限' });
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.9,
      allowsEditing: true,
      aspect: [1, 1],
    });

    if (result.canceled || !result.assets[0]) return;
    const resized = await resizeAvatarIfNeeded(result.assets[0].uri);
    if (!resized) {
      Toast.show({ type: 'error', text1: '处理失败', text2: '图片处理失败，请重试' });
      return;
    }
    setPendingAvatarUri(resized);
  };

  const handleRemoveAvatar = () => {
    setPendingAvatarUri(null);
    setAvatarKey(null);
    Toast.show({ type: 'success', text1: '已移除头像', text2: '点击保存后生效' });
  };

  // 纯数字验证（防乱码）
  const handleNumberInput = (text: string, setter: (v: string) => void) => {
    let cleaned = text.replace(/[^0-9.]/g, '');
    const parts = cleaned.split('.');
    if (parts.length > 2) {
      cleaned = parts[0] + '.' + parts.slice(1).join('');
    }
    setter(cleaned);
  };

  const handleSave = async () => {
    if (height) {
      const h = parseFloat(height);
      if (isNaN(h) || h < 50 || h > 300) {
        Toast.show({ type: 'error', text1: '输入有误', text2: '身高请输入 50~300 cm' });
        return;
      }
    }
    if (weight) {
      const w = parseFloat(weight);
      if (isNaN(w) || w < 20 || w > 500) {
        Toast.show({ type: 'error', text1: '输入有误', text2: '体重请输入 20~500 kg' });
        return;
      }
    }
    // 日期使用了原生选择器，一定合法，所以不再写正则检测非法日期，省去拦截代码
    if (trainingYears) {
      const y = parseFloat(trainingYears);
      if (isNaN(y) || y < 0 || y > 80) {
        Toast.show({ type: 'error', text1: '输入有误', text2: '训练年限请输入 0~80 年' });
        return;
      }
    }

    setSaving(true);
    try {
      const updates: Array<{ ok: boolean; error?: string }> = [];

      // 1) 上传头像
      let uploadedAvatarKey: string | null | undefined = undefined;
      if (pendingAvatarUri) {
        const upload = await api.uploadImage(pendingAvatarUri);
        if (!upload.success || !upload.data?.key) {
          Toast.show({ type: 'error', text1: '上传失败', text2: upload.error || '头像上传失败' });
          return;
        }
        uploadedAvatarKey = upload.data.key;
      }

      // 2) 更新用户基础信息
      const mePatch: { nickname?: string | null; avatar_key?: string | null } = {};
      const normalizedNickname = nickname.trim();
      mePatch.nickname = normalizedNickname ? normalizedNickname : null;
      if (uploadedAvatarKey !== undefined) mePatch.avatar_key = uploadedAvatarKey;
      if (uploadedAvatarKey === undefined && avatarKey === null) mePatch.avatar_key = null;

      if (Object.keys(mePatch).length > 0) {
        const meRes = await api.updateMe(mePatch);
        if (!meRes.success || !meRes.data) {
          Toast.show({ type: 'error', text1: '保存失败', text2: meRes.error || '用户信息更新失败' });
          return;
        }
        const nextUser = meRes.data as { id: string; email: string; nickname: string | null; avatar_key: string | null };
        setUser(nextUser);
        setAvatarKey(nextUser.avatar_key);
        setPendingAvatarUri(null);
        updates.push({ ok: true });
      }

      // 3) 更新身体数据
      const profilePatch: UpdateProfileRequest = {};
      if (height) profilePatch.height = parseFloat(height);
      if (weight) profilePatch.weight = parseFloat(weight);
      if (birthDate) profilePatch.birth_date = birthDate;
      if (gender) profilePatch.gender = gender as Gender;
      if (trainingStartTime) profilePatch.training_start_time = trainingStartTime;
      if (breakfastTime) profilePatch.breakfast_time = breakfastTime;
      if (lunchTime) profilePatch.lunch_time = lunchTime;
      if (dinnerTime) profilePatch.dinner_time = dinnerTime;
      if (trainingYears) profilePatch.training_years = parseFloat(trainingYears);

      if (Object.keys(profilePatch).length > 0) {
        const res = await api.updateProfile(profilePatch);
        if (!res.success) {
          Toast.show({ type: 'error', text1: '保存失败', text2: res.error || '身体数据更新失败' });
          return;
        }
        updates.push({ ok: true });
      }

      if (updates.length === 0) {
        Toast.show({ type: 'success', text1: '无需保存', text2: '没有检测到改动' });
        if (router.canGoBack()) router.back();
        else router.replace('/(tabs)/profile');
        return;
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Toast.show({ type: 'success', text1: '保存成功', text2: '个人资料已更新' });

      setTimeout(() => {
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace('/(tabs)/profile');
        }
      }, 500);

    } catch {
      Toast.show({ type: 'error', text1: '保存失败', text2: '网络错误' });
    } finally {
      setSaving(false);
    }
  };

  // 生成传递给 DatePicker 的有效日期对象
  const getPickerDate = () => {
    if (birthDate) {
      const d = new Date(birthDate);
      if (!isNaN(d.getTime())) return d;
    }
    return new Date(2000, 0, 1);
  };

  const handleDateChange = (event: any, selectedDate?: Date) => {
    // Android 会直接关闭并抛出事件（需要手动控制状态）
    if (Platform.OS === 'android') {
      setShowDatePicker(false);
    }
    if (selectedDate) {
      const yyyy = selectedDate.getFullYear();
      const mm = String(selectedDate.getMonth() + 1).padStart(2, '0');
      const dd = String(selectedDate.getDate()).padStart(2, '0');
      setBirthDate(`${yyyy}-${mm}-${dd}`);
    }
  };

  const getTimeValueByField = useCallback((): string => {
    switch (activeTimeField) {
      case 'training': return trainingStartTime;
      case 'breakfast': return breakfastTime;
      case 'lunch': return lunchTime;
      case 'dinner': return dinnerTime;
      default: return '';
    }
  }, [activeTimeField, trainingStartTime, breakfastTime, lunchTime, dinnerTime]);

  const setTimeValueByField = useCallback((value: string) => {
    switch (activeTimeField) {
      case 'training': setTrainingStartTime(value); break;
      case 'breakfast': setBreakfastTime(value); break;
      case 'lunch': setLunchTime(value); break;
      case 'dinner': setDinnerTime(value); break;
      default: break;
    }
  }, [activeTimeField]);

  const getPickerTime = () => {
    const base = new Date();
    const current = getTimeValueByField();
    if (current) {
      const match = /^(\d{1,2}):(\d{2})$/.exec(current.trim());
      if (match) {
        const hh = Number(match[1]);
        const mm = Number(match[2]);
        if (
          Number.isInteger(hh) &&
          Number.isInteger(mm) &&
          hh >= 0 &&
          hh <= 23 &&
          mm >= 0 &&
          mm <= 59
        ) {
          base.setHours(hh, mm, 0, 0);
          return base;
        }
      }
    }

    // 默认时间（按常见作息给一个合理起点）
    if (activeTimeField === 'breakfast') base.setHours(8, 0, 0, 0);
    else if (activeTimeField === 'lunch') base.setHours(12, 0, 0, 0);
    else if (activeTimeField === 'dinner') base.setHours(18, 0, 0, 0);
    else base.setHours(6, 0, 0, 0); // training / unknown
    return base;
  };

  const handleTimeChange = (event: any, selectedDate?: Date) => {
    if (Platform.OS === 'android') {
      setShowTimePicker(false);
      setActiveTimeField(null);
    }
    if (selectedDate) {
      const hh = String(selectedDate.getHours()).padStart(2, '0');
      const mm = String(selectedDate.getMinutes()).padStart(2, '0');
      setTimeValueByField(`${hh}:${mm}`);
    }
  };

  if (loading) return <LoadingScreen />;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ headerShown: true, title: '编辑资料' }} />
      <ScrollView
        style={[styles.container, { backgroundColor: Colors.borderLight }]} // 浅灰底板，凸显卡片
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* ===== Hero 头部叠拼渐变 ===== */}
        <LinearGradient
          colors={[...Gradients.hero]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.heroGradient}
        >
          {/* 头像 */}
          <View style={styles.avatarContainer}>
            <Pressable onPress={handlePickAvatar} style={styles.avatarPressable}>
              <View style={styles.avatarRing}>
                <View style={[styles.avatarInner, { backgroundColor: Colors.surface }]}>
                  {avatarSource ? (
                    <Image source={avatarSource} style={styles.avatarImage} />
                  ) : (
                    <Text style={[styles.avatarInitial, { color: Colors.primary }]}>{avatarInitial}</Text>
                  )}
                </View>
              </View>
              {/* 精致化的相机角标 */}
              <View style={[styles.cameraBadge, { backgroundColor: Colors.surface }]}>
                <Ionicons name="camera" size={12} color={Colors.primary} />
              </View>
            </Pressable>
          </View>

          {/* 操作按钮组 */}
          <View style={styles.heroActions}>
            <Pressable onPress={handlePickAvatar}>
              <Text style={styles.heroActionText}>更换头像</Text>
            </Pressable>
            {(avatarSource) && (
              <>
                <View style={styles.heroDot} />
                <Pressable onPress={handleRemoveAvatar}>
                  <Text style={[styles.heroActionText, { opacity: 0.8 }]}>移除</Text>
                </Pressable>
              </>
            )}
          </View>
        </LinearGradient>

        {/* ===== 卡片叠层区 ===== */}
        <View style={styles.overlapCardsContainer}>
          {/* 基础信息卡片 */}
          <Text style={[styles.miniHeader, { color: Colors.textTertiary }]}>基本信息</Text>
          <Card style={[styles.inlineCard, { backgroundColor: Colors.surface }]}>
            <InlineInputRow
              label="昵称"
              value={nickname}
              onChangeText={setNickname}
              placeholder="未设置"
              isLast
            />
          </Card>

          {/* 身体数据卡片 */}
          <Text style={[styles.miniHeader, { color: Colors.textTertiary }]}>身体数据</Text>
          <Card style={[styles.inlineCard, { backgroundColor: Colors.surface }]}>
            <InlineInputRow
              label="身高"
              value={height}
              onChangeText={(t: string) => handleNumberInput(t, setHeight)}
              placeholder="未设置"
              keyboardType="decimal-pad"
              maxLength={5}
              hint="cm"
            />
            <InlineInputRow
              label="体重"
              value={weight}
              onChangeText={(t: string) => handleNumberInput(t, setWeight)}
              placeholder="未设置"
              keyboardType="decimal-pad"
              maxLength={5}
              hint="kg"
            />
            {/* 新的日期交互 */}
            <InlinePressableRow
              label="出生日期"
              value={birthDate}
              placeholder="请选择"
              onPress={() => setShowDatePicker(true)}
            />
            <InlineOptionRow
              label="性别"
              options={Object.entries(GENDER_LABELS).map(([value, label]) => ({ value, label }))}
              selected={gender}
              onSelect={setGender}
            />
            <InlinePressableRow
              label="训练开始时间"
              value={trainingStartTime}
              placeholder="请选择"
              onPress={() => {
                setActiveTimeField('training');
                setShowTimePicker(true);
              }}
            />
            <InlinePressableRow
              label="早餐时间"
              value={breakfastTime}
              placeholder="请选择"
              onPress={() => {
                setActiveTimeField('breakfast');
                setShowTimePicker(true);
              }}
            />
            <InlinePressableRow
              label="午餐时间"
              value={lunchTime}
              placeholder="请选择"
              onPress={() => {
                setActiveTimeField('lunch');
                setShowTimePicker(true);
              }}
            />
            <InlinePressableRow
              label="晚餐时间"
              value={dinnerTime}
              placeholder="请选择"
              onPress={() => {
                setActiveTimeField('dinner');
                setShowTimePicker(true);
              }}
            />
            <InlineInputRow
              label="训练年限"
              value={trainingYears}
              onChangeText={(t: string) => handleNumberInput(t, setTrainingYears)}
              placeholder="0"
              keyboardType="decimal-pad"
              maxLength={4}
              hint="年"
              isLast
            />
          </Card>
        </View>

        {/* ===== 保存按钮 ===== */}
        <View style={styles.saveContainer}>
          <Button
            title={isDirty ? "保存修改" : "已是最新"}
            onPress={handleSave}
            loading={saving}
            disabled={!isDirty || saving}
            size="lg"
          />
        </View>
      </ScrollView>

      {/* ===== 出生日期选择器 ===== */}

      {/* iOS Modal Spinner 形式 */}
      {Platform.OS === 'ios' && (
        <Modal visible={showDatePicker} transparent animationType="slide">
          <View style={styles.modalOverlay}>
            <Pressable style={{ flex: 1 }} onPress={() => setShowDatePicker(false)} />
            <View style={[styles.modalContent, { backgroundColor: Colors.surface }]}>
              <View style={[styles.modalHeader, { borderBottomColor: Colors.borderLight }]}>
                <Pressable onPress={() => setShowDatePicker(false)} hitSlop={Spacing.md}>
                  <Text style={[styles.modalActionText, { color: Colors.textSecondary }]}>取消</Text>
                </Pressable>
                <Pressable onPress={() => setShowDatePicker(false)} hitSlop={Spacing.md}>
                  <Text style={[styles.modalActionText, { color: Colors.primary, fontWeight: '600' }]}>完成</Text>
                </Pressable>
              </View>
              <DateTimePicker
                value={getPickerDate()}
                mode="date"
                display="spinner"
                maximumDate={new Date()}
                textColor={Colors.text} // iOS 支持更改滚轮颜色适配深色
                onChange={handleDateChange}
              />
            </View>
          </View>
        </Modal>
      )}

      {/* Android Default 弹窗形式 */}
      {Platform.OS === 'android' && showDatePicker && (
        <DateTimePicker
          value={getPickerDate()}
          mode="date"
          display="default"
          maximumDate={new Date()}
          onChange={handleDateChange}
        />
      )}

      {/* ===== 作息时间选择器 ===== */}

      {/* iOS Modal Spinner 形式 */}
      {Platform.OS === 'ios' && (
        <Modal visible={showTimePicker} transparent animationType="slide">
          <View style={styles.modalOverlay}>
            <Pressable
              style={{ flex: 1 }}
              onPress={() => {
                setShowTimePicker(false);
                setActiveTimeField(null);
              }}
            />
            <View style={[styles.modalContent, { backgroundColor: Colors.surface }]}>
              <View style={[styles.modalHeader, { borderBottomColor: Colors.borderLight }]}>
                <Pressable
                  onPress={() => {
                    setShowTimePicker(false);
                    setActiveTimeField(null);
                  }}
                  hitSlop={Spacing.md}
                >
                  <Text style={[styles.modalActionText, { color: Colors.textSecondary }]}>取消</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setShowTimePicker(false);
                    setActiveTimeField(null);
                  }}
                  hitSlop={Spacing.md}
                >
                  <Text style={[styles.modalActionText, { color: Colors.primary, fontWeight: '600' }]}>完成</Text>
                </Pressable>
              </View>
              <DateTimePicker
                value={getPickerTime()}
                mode="time"
                display="spinner"
                is24Hour
                textColor={Colors.text}
                onChange={handleTimeChange}
              />
            </View>
          </View>
        </Modal>
      )}

      {/* Android Default 弹窗形式 */}
      {Platform.OS === 'android' && showTimePicker && (
        <DateTimePicker
          value={getPickerTime()}
          mode="time"
          display="default"
          is24Hour
          onChange={handleTimeChange}
        />
      )}

    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingBottom: 60 },

  // ---- Hero 渐变底板 ----
  heroGradient: {
    paddingTop: Spacing.xl,
    paddingBottom: 80,
    alignItems: 'center',
  },
  avatarContainer: {
    marginBottom: Spacing.md,
  },
  avatarPressable: {
    position: 'relative',
  },
  avatarRing: {
    width: 96,
    height: 96,
    borderRadius: 48,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarInner: {
    width: 88,
    height: 88,
    borderRadius: 44,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarImage: {
    width: 88,
    height: 88,
    borderRadius: 44,
  },
  avatarInitial: {
    fontSize: 32,
    fontWeight: '700',
  },
  cameraBadge: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    ...Shadows.sm,
  },

  heroActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: Spacing.xs,
  },
  heroActionText: {
    color: '#FFFFFF',
    fontSize: FontSize.sm,
    fontWeight: '500',
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
  },
  heroDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: 'rgba(255,255,255,0.5)',
  },

  // ---- 叠层卡片区 ----
  overlapCardsContainer: {
    marginTop: -55,
    paddingHorizontal: Spacing.lg,
  },
  miniHeader: {
    fontSize: FontSize.sm,
    fontWeight: '500',
    marginTop: Spacing.lg,
    marginBottom: Spacing.xs,
    marginLeft: Spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  inlineCard: {
    padding: 0,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.lg,
    ...Shadows.sm,
  },

  // ---- 内联极简表单行 ----
  inlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingVertical: 8,
  },
  inlineLabel: {
    fontSize: FontSize.md,
    fontWeight: '500',
  },
  inlineInputWrapper: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginLeft: Spacing.lg,
  },
  inlineInput: {
    flex: 1,
    fontSize: FontSize.md,
    height: '100%',
    paddingVertical: 0,
  },
  inlineInputText: {
    fontSize: FontSize.md,
    textAlign: 'right',
  },
  inlineHint: {
    fontSize: FontSize.md,
    marginLeft: 4,
  },
  inlineOptions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  inlineOptionChip: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 6,
    borderRadius: Radius.full,
  },
  inlineOptionText: {
    fontSize: FontSize.sm,
    fontWeight: '500',
  },

  saveContainer: {
    marginTop: Spacing.xxxl,
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.xl,
  },

  // ---- Modal ----
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    paddingBottom: Platform.OS === 'ios' ? 30 : 0,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalActionText: {
    fontSize: FontSize.md,
  }
});
