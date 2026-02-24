import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemeColor } from '../hooks/useThemeColor';
import { Spacing, Radius, FontSize, Shadows } from '../constants';
import type { BaseToastProps } from 'react-native-toast-message';

type ToastType = 'success' | 'error' | 'info';

const TOAST_ICONS: Record<ToastType, keyof typeof Ionicons.glyphMap> = {
  success: 'checkmark-circle',
  error: 'close-circle',
  info: 'information-circle',
};

function ToastBase({ text1, text2, type }: BaseToastProps & { type: ToastType }) {
  const Colors = useThemeColor();
  const colorMap: Record<ToastType, string> = {
    success: Colors.success,
    error: Colors.danger,
    info: Colors.info,
  };
  const accentColor = colorMap[type];

  return (
    <View style={[styles.container, { backgroundColor: Colors.surface, borderLeftColor: accentColor, shadowColor: Colors.text }]}>
      <View style={[styles.iconBox, { backgroundColor: accentColor + '15' }]}>
        <Ionicons name={TOAST_ICONS[type]} size={18} color={accentColor} />
      </View>
      <View style={styles.textBox}>
        {text1 ? <Text style={[styles.title, { color: Colors.text }]} numberOfLines={1}>{text1}</Text> : null}
        {text2 ? <Text style={[styles.message, { color: Colors.textSecondary }]} numberOfLines={2}>{text2}</Text> : null}
      </View>
    </View>
  );
}

export const toastConfig = {
  success: (props: BaseToastProps) => <ToastBase {...props} type="success" />,
  error: (props: BaseToastProps) => <ToastBase {...props} type="error" />,
  info: (props: BaseToastProps) => <ToastBase {...props} type="info" />,
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '90%',
    borderRadius: Radius.md,
    borderLeftWidth: 4,
    padding: Spacing.md,
    gap: Spacing.md,
    ...Shadows.lg,
  },
  iconBox: {
    width: 32,
    height: 32,
    borderRadius: Radius.lg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  textBox: {
    flex: 1,
  },
  title: {
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  message: {
    fontSize: FontSize.xs,
    marginTop: 2,
  },
});
