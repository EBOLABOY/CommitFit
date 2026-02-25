import { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { FontSize, Spacing } from '../constants';
import { useThemeColor } from '../hooks/useThemeColor';

// 使用已安装的 react-native-svg 实现圆环进度组件

interface ProgressRingProps {
    /** 进度值 0-1 */
    progress: number;
    /** 圆环直径 */
    size?: number;
    /** 环宽度 */
    strokeWidth?: number;
    /** 进度条颜色 */
    color?: string;
    /** 轨道颜色 */
    trackColor?: string;
    /** 中间显示的文字 */
    label?: string;
    /** 中间显示的数值 */
    value?: string | number;
    /** 数值下方的单位 */
    unit?: string;
}

export const ProgressRing = memo(function ProgressRing({
    progress,
    size = 120,
    strokeWidth = 10,
    color,
    trackColor,
    label,
    value,
    unit,
}: ProgressRingProps) {
    const Colors = useThemeColor();
    const activeColor = color || Colors.primary;
    const activeTrackColor = trackColor || Colors.borderLight;

    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const clampedProgress = Math.min(Math.max(progress, 0), 1);
    const strokeDashoffset = circumference * (1 - clampedProgress);

    return (
        <View style={[styles.container, { width: size, height: size }]}>
            <Svg width={size} height={size}>
                {/* 背景轨道 */}
                <Circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    stroke={activeTrackColor}
                    strokeWidth={strokeWidth}
                    fill="none"
                />
                {/* 进度弧 */}
                <Circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    stroke={activeColor}
                    strokeWidth={strokeWidth}
                    fill="none"
                    strokeDasharray={`${circumference}`}
                    strokeDashoffset={strokeDashoffset}
                    strokeLinecap="round"
                    rotation="-90"
                    origin={`${size / 2}, ${size / 2}`}
                />
            </Svg>
            {/* 中心文字 */}
            <View style={styles.centerContent}>
                {value !== undefined && (
                    <Text style={[styles.value, { color: Colors.text }]}>
                        {value}
                        {unit && <Text style={[styles.unit, { color: Colors.textTertiary }]}> {unit}</Text>}
                    </Text>
                )}
                {label && (
                    <Text style={[styles.label, { color: Colors.textTertiary }]}>{label}</Text>
                )}
            </View>
        </View>
    );
});

const styles = StyleSheet.create({
    container: {
        justifyContent: 'center',
        alignItems: 'center',
    },
    centerContent: {
        position: 'absolute',
        alignItems: 'center',
        justifyContent: 'center',
    },
    value: {
        fontSize: FontSize.xxl,
        fontWeight: '700',
    },
    unit: {
        fontSize: FontSize.xs,
        fontWeight: '400',
    },
    label: {
        fontSize: FontSize.xs,
        marginTop: Spacing.xs,
    },
});
