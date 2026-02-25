import { memo, useState, useCallback } from 'react';
import { View, Text, TextInput, TextInputProps, StyleSheet, TouchableOpacity, ActivityIndicator, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated';
import { Spacing, Radius, FontSize, Shadows, HitSlop, Gradients } from '../constants';
import { useThemeColor } from '../hooks/useThemeColor';

export * from './Skeleton';
export { ProgressRing } from './ProgressRing';

// ============ Card ============

interface CardProps {
  children: React.ReactNode;
  style?: object;
  onPress?: () => void;
  haptic?: boolean;
}

export function Card({ children, style, onPress, haptic = true }: CardProps) {
  const Colors = useThemeColor();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = useCallback(() => {
    if (onPress) {
      scale.value = withTiming(0.97, { duration: 120, easing: Easing.out(Easing.ease) });
    }
  }, [onPress, scale]);

  const handlePressOut = useCallback(() => {
    if (onPress) {
      scale.value = withTiming(1, { duration: 200, easing: Easing.out(Easing.back(1.5)) });
    }
  }, [onPress, scale]);

  const handlePress = useCallback(() => {
    if (onPress) {
      if (haptic) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onPress();
    }
  }, [onPress, haptic]);

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        style={[
          styles.card,
          { backgroundColor: Colors.surface, shadowColor: Colors.text },
          style
        ]}
        onPress={onPress ? handlePress : undefined}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={!onPress}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

// ============ Button ============

interface ButtonProps {
  title: string;
  onPress: () => void;
  color?: string; // 如果不传，默认使用主题的 primary
  variant?: 'filled' | 'outline' | 'ghost';
  icon?: keyof typeof Ionicons.glyphMap;
  loading?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  haptic?: boolean;
}

export function Button({
  title,
  onPress,
  color,
  variant = 'filled',
  icon,
  loading = false,
  disabled = false,
  size = 'md',
  haptic = true,
}: ButtonProps) {
  const Colors = useThemeColor();
  const activeColor = color || Colors.primary;

  const isFilled = variant === 'filled';
  const isOutline = variant === 'outline';
  const paddingV = size === 'sm' ? 8 : size === 'lg' ? 18 : 14;

  const handlePress = () => {
    if (haptic) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onPress();
  };

  return (
    <TouchableOpacity
      style={[
        styles.button,
        { paddingVertical: paddingV },
        isFilled && { backgroundColor: activeColor },
        isOutline && { borderWidth: 1.5, borderColor: activeColor },
        (disabled || loading) && { opacity: 0.5 },
      ]}
      onPress={handlePress}
      disabled={disabled || loading}
      activeOpacity={0.7}
    >
      {loading ? (
        <ActivityIndicator color={isFilled ? Colors.surface : activeColor} size="small" />
      ) : (
        <View style={styles.buttonInner}>
          {icon && (
            <Ionicons
              name={icon}
              size={size === 'sm' ? 16 : 20}
              color={isFilled ? Colors.surface : activeColor}
              style={{ marginRight: Spacing.xs }}
            />
          )}
          <Text
            style={[
              styles.buttonText,
              { fontSize: size === 'sm' ? FontSize.sm : FontSize.md },
              isFilled && { color: Colors.surface },
              !isFilled && { color: activeColor },
            ]}
          >
            {title}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

// ============ SectionHeader ============

interface SectionHeaderProps {
  title: string;
  action?: string;
  onAction?: () => void;
}

export const SectionHeader = memo(function SectionHeader({ title, action, onAction }: SectionHeaderProps) {
  const Colors = useThemeColor();
  return (
    <View style={styles.sectionHeader}>
      <Text style={[styles.sectionTitle, { color: Colors.text }]}>{title}</Text>
      {action && (
        <TouchableOpacity onPress={onAction}>
          <Text style={[styles.sectionAction, { color: Colors.primary }]}>{action}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
});

// ============ EmptyState ============

interface EmptyStateProps {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
  iconColor?: string;
}

export function EmptyState({ icon = 'folder-open-outline', title, subtitle, actionLabel, onAction, iconColor }: EmptyStateProps) {
  const Colors = useThemeColor();
  return (
    <View style={styles.emptyState}>
      <Ionicons name={icon} size={56} color={iconColor || Colors.disabled} />
      <Text style={[styles.emptyTitle, { color: Colors.textSecondary }]}>{title}</Text>
      {subtitle && <Text style={[styles.emptySubtitle, { color: Colors.textTertiary }]}>{subtitle}</Text>}
      {actionLabel && onAction && (
        <Button title={actionLabel} onPress={onAction} size="sm" variant="outline" />
      )}
    </View>
  );
}

// ============ Badge ============

interface BadgeProps {
  label: string;
  color?: string;
  bgColor?: string;
}

export const Badge = memo(function Badge({ label, color, bgColor }: BadgeProps) {
  const Colors = useThemeColor();
  const themeColor = color || Colors.primary;
  return (
    <View style={[styles.badge, { backgroundColor: bgColor || themeColor + '18' }]}>
      <Text style={[styles.badgeText, { color: themeColor }]}>{label}</Text>
    </View>
  );
});

// ============ ListItem ============

interface ListItemProps {
  icon?: keyof typeof Ionicons.glyphMap;
  iconColor?: string;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  showChevron?: boolean;
  destructive?: boolean;
}

export function ListItem({ icon, iconColor, title, subtitle, right, onPress, showChevron = true, destructive }: ListItemProps) {
  const Colors = useThemeColor();
  const activeIconColor = iconColor || Colors.textSecondary;

  return (
    <TouchableOpacity
      style={styles.listItem}
      onPress={onPress}
      activeOpacity={onPress ? 0.6 : 1}
      disabled={!onPress}
    >
      {icon && (
        <View style={[styles.listItemIcon, { backgroundColor: activeIconColor + '12' }]}>
          <Ionicons name={icon} size={20} color={activeIconColor} />
        </View>
      )}
      <View style={styles.listItemContent}>
        <Text style={[styles.listItemTitle, { color: Colors.text }, destructive && { color: Colors.danger }]}>{title}</Text>
        {subtitle && <Text style={[styles.listItemSubtitle, { color: Colors.textTertiary }]}>{subtitle}</Text>}
      </View>
      {right || (showChevron && onPress && <Ionicons name="chevron-forward" size={18} color={Colors.disabled} />)}
    </TouchableOpacity>
  );
}

// ============ LoadingScreen ============

export function LoadingScreen() {
  const Colors = useThemeColor();
  return (
    <View style={[styles.loadingScreen, { backgroundColor: Colors.background }]}>
      <ActivityIndicator size="large" color={Colors.primary} />
    </View>
  );
}

// ============ FormField ============

interface FormFieldProps {
  label: string;
  children: React.ReactNode;
  hint?: string;
}

export function FormField({ label, children, hint }: FormFieldProps) {
  const Colors = useThemeColor();
  return (
    <View style={styles.formField}>
      <Text style={[styles.formLabel, { color: Colors.textSecondary }]}>{label}</Text>
      {children}
      {hint && <Text style={[styles.formHint, { color: Colors.textTertiary }]}>{hint}</Text>}
    </View>
  );
}

// ============ ThemedInput ============

interface ThemedInputProps extends Omit<TextInputProps, 'style'> {
  style?: object;
}

export function ThemedInput({ style, ...props }: ThemedInputProps) {
  const Colors = useThemeColor();
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      {...props}
      placeholderTextColor={Colors.textTertiary}
      onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
      style={[
        styles.themedInput,
        { backgroundColor: Colors.surface, borderColor: focused ? Colors.primary : Colors.border, color: Colors.text },
        focused && { shadowColor: Colors.primary, shadowOpacity: 0.12, shadowOffset: { width: 0, height: 0 }, shadowRadius: 8, elevation: 2 },
        style,
      ]}
    />
  );
}

// ============ OptionPicker ============

interface OptionPickerProps {
  options: Array<{ value: string; label: string }>;
  selected: string | null;
  onSelect: (value: string) => void;
  color?: string;
}

export function OptionPicker({ options, selected, onSelect, color }: OptionPickerProps) {
  const Colors = useThemeColor();
  const themeColor = color || Colors.primary;

  return (
    <View style={styles.optionRow}>
      {options.map((opt) => {
        const active = selected === opt.value;
        return (
          <TouchableOpacity
            key={opt.value}
            style={[
              styles.optionChip,
              { backgroundColor: Colors.surface, borderColor: Colors.border },
              active && { backgroundColor: themeColor, borderColor: themeColor },
            ]}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onSelect(opt.value);
            }}
          >
            <Text style={[styles.optionChipText, { color: Colors.textSecondary }, active && { color: Colors.surface }]}>{opt.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ============ StatCard ============

interface StatCardProps {
  label: string;
  value: string | number | null;
  unit?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  color?: string;
}

export const StatCard = memo(function StatCard({ label, value, unit, icon, color }: StatCardProps) {
  const Colors = useThemeColor();
  const themeColor = color || Colors.primary;

  return (
    <View style={[styles.statCard, { backgroundColor: Colors.surface }]}>
      {icon && (
        <View style={[styles.statIcon, { backgroundColor: themeColor + '15' }]}>
          <Ionicons name={icon} size={18} color={themeColor} />
        </View>
      )}
      <Text style={[styles.statValue, { color: Colors.text }]}>
        {value ?? '--'}
        {unit && <Text style={[styles.statUnit, { color: Colors.textTertiary }]}> {unit}</Text>}
      </Text>
      <Text style={[styles.statLabel, { color: Colors.textTertiary }]}>{label}</Text>
    </View>
  );
});

// ============ Styles ============
// 注意：移除了硬编码 Colors 属性到内联样式中（动态注入）

const styles = StyleSheet.create({
  // Card
  card: {
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    ...Shadows.md,
  },

  // Button
  button: {
    borderRadius: Radius.full, // 更加现代的全圆角
    paddingHorizontal: Spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonInner: { flexDirection: 'row', alignItems: 'center' },
  buttonText: { fontWeight: '600' },

  // SectionHeader
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '700' },
  sectionAction: { fontSize: FontSize.sm, fontWeight: '500' },

  // EmptyState
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.xxxl,
    gap: Spacing.md,
  },
  emptyTitle: { fontSize: FontSize.md, fontWeight: '500' },
  emptySubtitle: { fontSize: FontSize.sm, textAlign: 'center', maxWidth: 240 },

  // Badge
  badge: { paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs, borderRadius: Radius.full },
  badgeText: { fontSize: FontSize.xs, fontWeight: '600' },

  // ListItem
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    gap: Spacing.lg, // 放大内部间隙
  },
  listItemIcon: {
    width: 40,
    height: 40,
    borderRadius: Radius.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listItemContent: { flex: 1 },
  listItemTitle: { fontSize: FontSize.md, fontWeight: '500' },
  listItemSubtitle: { fontSize: FontSize.sm, marginTop: Spacing.xs },

  // LoadingScreen
  loadingScreen: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  // FormField
  formField: { marginBottom: Spacing.xl },
  formLabel: { fontSize: FontSize.sm, fontWeight: '600', marginBottom: Spacing.sm },
  formHint: { fontSize: FontSize.xs, marginTop: Spacing.xs },

  // ThemedInput
  themedInput: {
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.lg,
    fontSize: FontSize.md,
  },

  // OptionPicker
  optionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  optionChip: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: Radius.full,
    borderWidth: 1.5,
  },
  optionChipText: { fontSize: FontSize.sm, fontWeight: '500' },

  // StatCard
  statCard: {
    borderRadius: Radius.xl,
    padding: Spacing.lg,
    alignItems: 'center',
    flex: 1,
    gap: Spacing.xs,
  },
  statIcon: { width: 36, height: 36, borderRadius: Radius.lg, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.xs },
  statValue: { fontSize: FontSize.xxl, fontWeight: '700' },
  statUnit: { fontSize: FontSize.xs, fontWeight: '400' },
  statLabel: { fontSize: FontSize.sm, fontWeight: '400' },
});

// ============ GradientButton ============

interface GradientButtonProps {
  title: string;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  subtitle?: string;
  loading?: boolean;
  disabled?: boolean;
  colors?: readonly [string, string];
}

export function GradientButton({
  title,
  onPress,
  icon,
  subtitle,
  loading = false,
  disabled = false,
  colors,
}: GradientButtonProps) {
  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onPress();
  };

  const gradientColors = colors || Gradients.hero;

  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={disabled || loading}
      activeOpacity={0.85}
      style={(disabled || loading) ? { opacity: 0.5 } : undefined}
    >
      <LinearGradient
        colors={[...gradientColors]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={gradientButtonStyles.container}
      >
        {loading ? (
          <ActivityIndicator color="#FFF" size="small" />
        ) : (
          <View style={gradientButtonStyles.inner}>
            <View style={gradientButtonStyles.textBlock}>
              <Text style={gradientButtonStyles.title}>{title}</Text>
              {subtitle && <Text style={gradientButtonStyles.subtitle}>{subtitle}</Text>}
            </View>
            {icon && (
              <View style={gradientButtonStyles.iconCircle}>
                <Ionicons name={icon} size={20} color="#FFF" />
              </View>
            )}
          </View>
        )}
      </LinearGradient>
    </TouchableOpacity>
  );
}

const gradientButtonStyles = StyleSheet.create({
  container: {
    borderRadius: Radius.xl,
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.xl,
    ...Shadows.md,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  textBlock: {
    flex: 1,
  },
  title: {
    fontSize: FontSize.lg,
    fontWeight: '700',
    color: '#FFF',
  },
  subtitle: {
    fontSize: FontSize.xs,
    color: 'rgba(255,255,255,0.8)',
    marginTop: 2,
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
