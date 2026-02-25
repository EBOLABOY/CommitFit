import React, { useEffect } from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withRepeat,
    withTiming,
    Easing,
    interpolate,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useThemeColor } from '../hooks/useThemeColor';

// 带 shimmer 闪光效果的高级骨架屏组件

interface SkeletonProps {
    width?: number | string;
    height?: number | string;
    style?: ViewStyle;
    borderRadius?: number;
}

export function Skeleton({ width = '100%', height = 20, style, borderRadius = 8 }: SkeletonProps) {
    const themeColors = useThemeColor();
    const shimmerTranslate = useSharedValue(0);

    useEffect(() => {
        shimmerTranslate.value = withRepeat(
            withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
            -1, // 无限循环
            false // 不反转，单向扫过
        );
    }, [shimmerTranslate]);

    const shimmerStyle = useAnimatedStyle(() => {
        const translateX = interpolate(
            shimmerTranslate.value,
            [0, 1],
            [-200, 200]
        );
        return {
            transform: [{ translateX }],
        };
    });

    return (
        <View
            style={[
                styles.skeleton,
                {
                    width: width as any,
                    height: height as any,
                    borderRadius,
                    backgroundColor: themeColors.border,
                },
                style,
            ]}
        >
            <Animated.View style={[styles.shimmerContainer, shimmerStyle]}>
                <LinearGradient
                    colors={[
                        'transparent',
                        themeColors.surface + '80',
                        themeColors.surface + 'CC',
                        themeColors.surface + '80',
                        'transparent',
                    ]}
                    start={{ x: 0, y: 0.5 }}
                    end={{ x: 1, y: 0.5 }}
                    style={styles.shimmerGradient}
                />
            </Animated.View>
        </View>
    );
}

const styles = StyleSheet.create({
    skeleton: {
        overflow: 'hidden',
    },
    shimmerContainer: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: 200,
    },
    shimmerGradient: {
        flex: 1,
    },
});
