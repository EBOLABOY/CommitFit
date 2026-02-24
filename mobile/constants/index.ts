export const API_BASE_URL = __DEV__
  ? 'https://api-lite.izlx.de5.net'
  : 'https://api-lite.izlx.de5.net';

// ============ Design Tokens ============

export const LightColors = {
  primary: '#FF6B35',      // 品牌珊瑚橙
  primaryLight: '#FFF4EF',
  primaryAlpha: 'rgba(255, 107, 53, 0.10)',
  danger: '#DC2626',       // Apple 红
  dangerLight: '#FEF2F2',
  info: '#0EA5E9',         // 天空蓝
  infoLight: '#F0F9FF',
  success: '#16A34A',      // 翡翠绿
  successLight: '#F0FDF4',
  warning: '#EAB308',      // 琥珀黄
  warningLight: '#FEFCE8',

  text: '#0F172A',         // Slate 900，极深
  textSecondary: '#64748B', // Slate 500
  textTertiary: '#94A3B8',  // Slate 400
  background: '#F8FAFC',   // Slate 50，几乎白
  surface: '#FFFFFF',
  border: '#E2E8F0',       // Slate 200
  borderLight: '#F1F5F9',  // Slate 100
  disabled: '#CBD5E1',     // Slate 300

  glassBackground: 'rgba(255, 255, 255, 0.78)',
};

export const DarkColors = {
  primary: '#FF8555',      // 暗模式下提亮的珊瑚
  primaryLight: '#431407',
  primaryAlpha: 'rgba(255, 133, 85, 0.15)',
  danger: '#EF4444',
  dangerLight: '#450a0a',
  info: '#38BDF8',
  infoLight: '#0c4a6e',
  success: '#22C55E',
  successLight: '#064e3b',
  warning: '#FACC15',
  warningLight: '#713f12',

  text: '#F8FAFC',
  textSecondary: '#94A3B8',
  textTertiary: '#64748B',
  background: '#020617',   // Slate 950
  surface: '#0F172A',      // Slate 900
  border: '#334155',       // Slate 700
  borderLight: '#1E293B',  // Slate 800
  disabled: '#475569',     // Slate 600

  glassBackground: 'rgba(15, 23, 42, 0.78)',
};

// 兼容原有写法，默认指向 Light
export const Colors = LightColors;

export type ThemeColors = typeof LightColors;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const Radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 999,
} as const;

export const FontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
  xxl: 24,
  title: 28,
  hero: 34,
} as const;

// ============ Shadows ============

export const Shadows = {
  sm: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 4, elevation: 1 },
  md: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 3 },
  lg: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.10, shadowRadius: 12, elevation: 5 },
} as const;

// ============ HitSlop ============

export const HitSlop = {
  sm: { top: 8, bottom: 8, left: 8, right: 8 },
  md: { top: 12, bottom: 12, left: 12, right: 12 },
} as const;

// ============ AI Roles ============

export const AI_ROLES = {
  doctor: { name: '运动医生', icon: 'heart' as const, color: '#DC2626', colorLight: '#FEF2F2', description: '解读体检指标，评估运动风险' },
  rehab: { name: '康复师', icon: 'fitness' as const, color: '#0EA5E9', colorLight: '#F0F9FF', description: '伤病评估，康复方案制定' },
  nutritionist: { name: '营养师', icon: 'nutrition' as const, color: '#16A34A', colorLight: '#F0FDF4', description: '营养方案，饮食搭配指导' },
  trainer: { name: '私人教练', icon: 'barbell' as const, color: '#FF6B35', colorLight: '#FFF4EF', description: '训练计划制定与调整' },
} as const;

// ============ Enum Labels ============

export const GENDER_LABELS: Record<string, string> = {
  male: '男',
  female: '女',
};

export const EXPERIENCE_LABELS: Record<string, string> = {
  beginner: '新手',
  intermediate: '中级',
  advanced: '高级',
};

export const SEVERITY_LABELS: Record<string, string> = {
  mild: '轻度',
  moderate: '中度',
  severe: '重度',
};

export const METRIC_TYPE_LABELS: Record<string, string> = {
  testosterone: '睾酮',
  blood_pressure: '血压',
  blood_lipids: '血脂',
  blood_sugar: '血糖',
  heart_rate: '心率',
  body_fat: '体脂率',
  other: '其他',
};
