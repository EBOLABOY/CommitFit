import { useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import Toast from 'react-native-toast-message';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Spacing, Radius, FontSize, Shadows } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';
import { api, streamChat } from '../../services/api';
import { Card } from '../../components/ui';
import type { MealType, FoodAnalysisResult, FoodItem } from '../../../shared/types';

const MAX_IMAGE_DIMENSION = 1600;
const INLINE_THRESHOLD = 500 * 1024;

const MEAL_OPTIONS: { value: MealType; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { value: 'breakfast', label: '早餐', icon: 'sunny-outline' },
  { value: 'lunch', label: '午餐', icon: 'partly-sunny-outline' },
  { value: 'dinner', label: '晚餐', icon: 'moon-outline' },
  { value: 'snack', label: '加餐', icon: 'cafe-outline' },
];

function getMealType(): MealType {
  const hour = new Date().getHours();
  if (hour < 10) return 'breakfast';
  if (hour < 14) return 'lunch';
  if (hour < 17) return 'snack';
  return 'dinner';
}

function getTodayDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type InputMode = 'text' | 'photo';

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function normalizeFoodItem(item: unknown): FoodItem | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const name = String(obj.name || obj.food || '').trim() || '未命名食物';
  const amount = String(obj.amount || obj.portion || obj.weight || '').trim() || '1份';
  return {
    name,
    amount,
    calories: toNumber(obj.calories),
    protein: toNumber(obj.protein),
    fat: toNumber(obj.fat),
    carbs: toNumber(obj.carbs),
  };
}

function buildTotalFromFoods(foods: FoodItem[]) {
  return foods.reduce(
    (acc, item) => ({
      calories: acc.calories + toNumber(item.calories),
      protein: acc.protein + toNumber(item.protein),
      fat: acc.fat + toNumber(item.fat),
      carbs: acc.carbs + toNumber(item.carbs),
    }),
    { calories: 0, protein: 0, fat: 0, carbs: 0 }
  );
}

function parseFoodAnalysisResult(raw: string): FoodAnalysisResult | null {
  const candidates: string[] = [];
  const fenceMatches = raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const m of fenceMatches) {
    if (m[1]) candidates.push(m[1].trim());
  }
  candidates.push(raw.trim());

  for (const candidate of candidates) {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    const source = firstBrace >= 0 && lastBrace > firstBrace ? candidate.slice(firstBrace, lastBrace + 1) : candidate;
    try {
      const parsed = JSON.parse(source) as { foods?: unknown; total?: Record<string, unknown> };
      if (!Array.isArray(parsed.foods)) continue;
      const foods = parsed.foods.map(normalizeFoodItem).filter((x): x is FoodItem => !!x);
      if (foods.length === 0) continue;
      const fallbackTotal = buildTotalFromFoods(foods);
      const totalObj = parsed.total || {};
      return {
        foods,
        total: {
          calories: toNumber(totalObj.calories ?? fallbackTotal.calories),
          protein: toNumber(totalObj.protein ?? fallbackTotal.protein),
          fat: toNumber(totalObj.fat ?? fallbackTotal.fat),
          carbs: toNumber(totalObj.carbs ?? fallbackTotal.carbs),
        },
      };
    } catch {
      // try next candidate
    }
  }

  return null;
}

function buildDietAnalysisPrompt(inputMode: InputMode, description: string) {
  const cleanDesc = description.trim();
  const context =
    inputMode === 'photo'
      ? `这是食物图片分析任务。用户补充描述：${cleanDesc || '无补充描述'}`
      : `这是文字饮食分析任务。用户描述：${cleanDesc}`;

  return [
    '你是专业营养师，请对本次饮食做营养估算。',
    context,
    '请严格只返回 JSON，不要 Markdown、不要解释、不要多余文本。',
    'JSON 格式如下：',
    '{"foods":[{"name":"食物名","amount":"份量","calories":120,"protein":10,"fat":4,"carbs":12}],"total":{"calories":120,"protein":10,"fat":4,"carbs":12}}',
    '要求：数值使用数字，若无法精确请给合理估算；foods 至少 1 项。',
  ].join('\n');
}

export default function DietRecordScreen() {
  const router = useRouter();
  const Colors = useThemeColor();

  const [mealType, setMealType] = useState<MealType>(getMealType);
  const [inputMode, setInputMode] = useState<InputMode>('text');
  const [description, setDescription] = useState('');
  const [pendingImage, setPendingImage] = useState<{ uri: string; base64: string } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<FoodAnalysisResult | null>(null);
  const [saving, setSaving] = useState(false);

  const todayDate = useMemo(() => getTodayDate(), []);

  const canAnalyze = inputMode === 'text' ? description.trim().length > 0 : !!pendingImage;
  const canSave = !!analysisResult;

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

  const handlePickImage = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Toast.show({ type: 'error', text1: '权限不足', text2: '需要相册访问权限' });
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    if (!result.canceled && result.assets[0]) {
      const data = await resizeImage(result.assets[0].uri);
      if (data) {
        setPendingImage(data);
        setAnalysisResult(null);
      }
    }
  }, []);

  const handleTakePhoto = useCallback(async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Toast.show({ type: 'error', text1: '权限不足', text2: '需要相机权限' });
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
    if (!result.canceled && result.assets[0]) {
      const data = await resizeImage(result.assets[0].uri);
      if (data) {
        setPendingImage(data);
        setAnalysisResult(null);
      }
    }
  }, []);

  const handleImageButton = useCallback(() => {
    Alert.alert('添加食物照片', '选择图片来源', [
      { text: '拍照', onPress: handleTakePhoto },
      { text: '从相册选择', onPress: handlePickImage },
      { text: '取消', style: 'cancel' },
    ]);
  }, [handleTakePhoto, handlePickImage]);

  const handleAnalyze = useCallback(async () => {
    if (analyzing) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setAnalyzing(true);
    setAnalysisResult(null);

    try {
      const prompt = buildDietAnalysisPrompt(inputMode, description);

      let imageOption: { inline: string } | { key: string } | undefined;
      if (inputMode === 'photo') {
        if (!pendingImage) return;
        if (pendingImage.base64.length < INLINE_THRESHOLD) {
          imageOption = { inline: `data:image/jpeg;base64,${pendingImage.base64}` };
        } else {
          try {
            const uploadRes = await api.uploadImage(pendingImage.uri);
            if (uploadRes.success && uploadRes.data?.key) {
              imageOption = { key: uploadRes.data.key };
            } else {
              imageOption = { inline: `data:image/jpeg;base64,${pendingImage.base64}` };
            }
          } catch {
            imageOption = { inline: `data:image/jpeg;base64,${pendingImage.base64}` };
          }
        }
      }

      const aiRawText = await new Promise<string>((resolve, reject) => {
        let merged = '';
        streamChat(
          'nutritionist',
          prompt,
          (chunk) => {
            merged += chunk;
          },
          () => resolve(merged),
          (err) => reject(err),
          imageOption
        );
      });

      const parsed = parseFoodAnalysisResult(aiRawText);
      if (!parsed) {
        Toast.show({ type: 'error', text1: '分析失败', text2: 'AI 返回格式异常，请重试' });
        return;
      }
      setAnalysisResult(parsed);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Toast.show({ type: 'error', text1: '网络错误', text2: '请检查网络后重试' });
    } finally {
      setAnalyzing(false);
    }
  }, [analyzing, inputMode, description, pendingImage]);

  const handleSave = useCallback(async () => {
    if (!analysisResult || saving) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSaving(true);

    try {
      const foodDesc = description.trim() || (pendingImage ? '拍照记录' : '');
      const res = await api.createDietRecord({
        meal_type: mealType,
        record_date: todayDate,
        food_description: foodDesc,
        foods_json: JSON.stringify(analysisResult.foods),
        calories: analysisResult.total.calories,
        protein: analysisResult.total.protein,
        fat: analysisResult.total.fat,
        carbs: analysisResult.total.carbs,
      });

      if (res.success) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Toast.show({ type: 'success', text1: '保存成功', text2: '饮食记录已保存' });
        router.back();
      } else {
        Toast.show({ type: 'error', text1: '保存失败', text2: res.error || '请重试' });
      }
    } catch {
      Toast.show({ type: 'error', text1: '网络错误', text2: '请检查网络后重试' });
    } finally {
      setSaving(false);
    }
  }, [analysisResult, saving, description, pendingImage, mealType, todayDate, router]);

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: Colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <Stack.Screen options={{ headerShown: true, title: '记录饮食', headerTintColor: Colors.text }} />

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        {/* Meal type selector */}
        <View style={styles.mealSelector}>
          {MEAL_OPTIONS.map((opt) => {
            const active = mealType === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                style={[
                  styles.mealChip,
                  { backgroundColor: Colors.surface, borderColor: Colors.border },
                  active && { backgroundColor: Colors.primary, borderColor: Colors.primary },
                ]}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setMealType(opt.value);
                }}
                activeOpacity={0.7}
              >
                <Ionicons name={opt.icon} size={16} color={active ? '#FFF' : Colors.textSecondary} />
                <Text style={[styles.mealChipText, { color: active ? '#FFF' : Colors.textSecondary }]}>{opt.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Input mode toggle */}
        <View style={styles.modeToggle}>
          <TouchableOpacity
            style={[
              styles.modeButton,
              { backgroundColor: inputMode === 'photo' ? Colors.primary : Colors.surface, borderColor: inputMode === 'photo' ? Colors.primary : Colors.border },
            ]}
            onPress={() => { setInputMode('photo'); setAnalysisResult(null); }}
            activeOpacity={0.7}
          >
            <Ionicons name="camera-outline" size={22} color={inputMode === 'photo' ? '#FFF' : Colors.textSecondary} />
            <Text style={[styles.modeText, { color: inputMode === 'photo' ? '#FFF' : Colors.textSecondary }]}>拍照</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.modeButton,
              { backgroundColor: inputMode === 'text' ? Colors.primary : Colors.surface, borderColor: inputMode === 'text' ? Colors.primary : Colors.border },
            ]}
            onPress={() => { setInputMode('text'); setAnalysisResult(null); }}
            activeOpacity={0.7}
          >
            <Ionicons name="create-outline" size={22} color={inputMode === 'text' ? '#FFF' : Colors.textSecondary} />
            <Text style={[styles.modeText, { color: inputMode === 'text' ? '#FFF' : Colors.textSecondary }]}>文字</Text>
          </TouchableOpacity>
        </View>

        {/* Input area */}
        {inputMode === 'photo' ? (
          <View style={styles.photoArea}>
            {pendingImage ? (
              <View style={styles.imagePreviewContainer}>
                <Image source={{ uri: pendingImage.uri }} style={styles.imagePreview} resizeMode="cover" />
                <TouchableOpacity style={styles.removeImage} onPress={() => { setPendingImage(null); setAnalysisResult(null); }}>
                  <Ionicons name="close-circle" size={28} color={Colors.danger} />
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                style={[styles.photoPlaceholder, { backgroundColor: Colors.surface, borderColor: Colors.border }]}
                onPress={handleImageButton}
                activeOpacity={0.7}
              >
                <Ionicons name="camera" size={40} color={Colors.disabled} />
                <Text style={[styles.photoHint, { color: Colors.textTertiary }]}>点击拍照或选择图片</Text>
              </TouchableOpacity>
            )}
            {/* Optional text description for photo */}
            <TextInput
              style={[styles.descInput, { backgroundColor: Colors.surface, borderColor: Colors.border, color: Colors.text }]}
              placeholder="可选：补充描述（如份量）"
              placeholderTextColor={Colors.textTertiary}
              value={description}
              onChangeText={setDescription}
              multiline
              maxLength={500}
            />
          </View>
        ) : (
          <TextInput
            style={[styles.textInput, { backgroundColor: Colors.surface, borderColor: Colors.border, color: Colors.text }]}
            placeholder="描述你吃了什么，如：两个鸡蛋、一碗燕麦粥、一杯牛奶"
            placeholderTextColor={Colors.textTertiary}
            value={description}
            onChangeText={(t) => { setDescription(t); setAnalysisResult(null); }}
            multiline
            maxLength={500}
          />
        )}

        {/* Analyze button */}
        <TouchableOpacity
          style={[styles.analyzeButton, { backgroundColor: canAnalyze && !analyzing ? Colors.primary : Colors.disabled }]}
          onPress={handleAnalyze}
          disabled={!canAnalyze || analyzing}
          activeOpacity={0.7}
        >
          {analyzing ? (
            <ActivityIndicator color="#FFF" size="small" />
          ) : (
            <Ionicons name="search" size={20} color="#FFF" />
          )}
          <Text style={styles.analyzeText}>{analyzing ? 'AI 分析中...' : '分析食物'}</Text>
        </TouchableOpacity>

        {/* Analysis result */}
        {analysisResult && (
          <Animated.View entering={FadeInDown.duration(400)}>
            <Card style={[styles.resultCard, { marginTop: Spacing.lg }]}>
              <Text style={[styles.resultTitle, { color: Colors.text }]}>营养分析结果</Text>

              {/* Food items */}
              {analysisResult.foods.map((food, i) => (
                <View key={i} style={[styles.foodItem, { borderBottomColor: Colors.borderLight }]}>
                  <View style={styles.foodMain}>
                    <Text style={[styles.foodName, { color: Colors.text }]}>{food.name}</Text>
                    <Text style={[styles.foodAmount, { color: Colors.textTertiary }]}>{food.amount}</Text>
                  </View>
                  <Text style={[styles.foodCal, { color: Colors.primary }]}>{Math.round(food.calories)} kcal</Text>
                </View>
              ))}

              {/* Total */}
              <View style={[styles.totalSection, { borderTopColor: Colors.border }]}>
                <Text style={[styles.totalLabel, { color: Colors.text }]}>合计</Text>
                <Text style={[styles.totalCal, { color: Colors.primary }]}>{Math.round(analysisResult.total.calories)} kcal</Text>
              </View>

              {/* Macro nutrients */}
              <View style={styles.macroRow}>
                <View style={[styles.macroItem, { backgroundColor: Colors.infoLight }]}>
                  <Text style={[styles.macroValue, { color: Colors.info }]}>{Math.round(analysisResult.total.protein)}g</Text>
                  <Text style={[styles.macroLabel, { color: Colors.info }]}>蛋白质</Text>
                </View>
                <View style={[styles.macroItem, { backgroundColor: Colors.warningLight }]}>
                  <Text style={[styles.macroValue, { color: Colors.warning }]}>{Math.round(analysisResult.total.fat)}g</Text>
                  <Text style={[styles.macroLabel, { color: Colors.warning }]}>脂肪</Text>
                </View>
                <View style={[styles.macroItem, { backgroundColor: Colors.successLight }]}>
                  <Text style={[styles.macroValue, { color: Colors.success }]}>{Math.round(analysisResult.total.carbs)}g</Text>
                  <Text style={[styles.macroLabel, { color: Colors.success }]}>碳水</Text>
                </View>
              </View>
            </Card>

            {/* Save button */}
            <TouchableOpacity
              style={[styles.saveButton, { backgroundColor: canSave && !saving ? Colors.success : Colors.disabled }]}
              onPress={handleSave}
              disabled={!canSave || saving}
              activeOpacity={0.7}
            >
              {saving ? (
                <ActivityIndicator color="#FFF" size="small" />
              ) : (
                <Ionicons name="checkmark-circle" size={20} color="#FFF" />
              )}
              <Text style={styles.saveText}>{saving ? '保存中...' : '保存记录'}</Text>
            </TouchableOpacity>
          </Animated.View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { padding: Spacing.xl, paddingBottom: 60 },

  // Meal selector
  mealSelector: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.lg,
  },
  mealChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
    paddingVertical: Spacing.md,
    borderRadius: Radius.full,
    borderWidth: 1.5,
  },
  mealChipText: { fontSize: FontSize.sm, fontWeight: '600' },

  // Mode toggle
  modeToggle: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginBottom: Spacing.lg,
  },
  modeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.lg,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    ...Shadows.sm,
  },
  modeText: { fontSize: FontSize.md, fontWeight: '600' },

  // Photo area
  photoArea: { marginBottom: Spacing.lg },
  photoPlaceholder: {
    height: 200,
    borderRadius: Radius.lg,
    borderWidth: 2,
    borderStyle: 'dashed',
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  photoHint: { fontSize: FontSize.sm },
  imagePreviewContainer: { position: 'relative', marginBottom: Spacing.md },
  imagePreview: {
    width: '100%',
    height: 220,
    borderRadius: Radius.lg,
  },
  removeImage: { position: 'absolute', top: Spacing.sm, right: Spacing.sm },
  descInput: {
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.md,
    fontSize: FontSize.md,
    minHeight: 44,
  },

  // Text input
  textInput: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    fontSize: FontSize.md,
    minHeight: 100,
    textAlignVertical: 'top',
    marginBottom: Spacing.lg,
    lineHeight: 22,
  },

  // Analyze button
  analyzeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.lg,
    borderRadius: Radius.full,
  },
  analyzeText: { color: '#FFF', fontSize: FontSize.md, fontWeight: '600' },

  // Result card
  resultCard: { padding: Spacing.lg },
  resultTitle: { fontSize: FontSize.lg, fontWeight: '700', marginBottom: Spacing.md },
  foodItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
  },
  foodMain: { flex: 1 },
  foodName: { fontSize: FontSize.md, fontWeight: '500' },
  foodAmount: { fontSize: FontSize.sm, marginTop: 2 },
  foodCal: { fontSize: FontSize.md, fontWeight: '600' },

  totalSection: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: Spacing.md,
    marginTop: Spacing.xs,
    borderTopWidth: 1.5,
  },
  totalLabel: { fontSize: FontSize.md, fontWeight: '700' },
  totalCal: { fontSize: FontSize.xl, fontWeight: '700' },

  macroRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.lg,
  },
  macroItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.md,
    borderRadius: Radius.md,
  },
  macroValue: { fontSize: FontSize.lg, fontWeight: '700' },
  macroLabel: { fontSize: FontSize.xs, marginTop: 2 },

  // Save button
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.lg,
    borderRadius: Radius.full,
    marginTop: Spacing.lg,
  },
  saveText: { color: '#FFF', fontSize: FontSize.md, fontWeight: '600' },
});
