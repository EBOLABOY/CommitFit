import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, Modal, TouchableOpacity, Dimensions, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { G, Polyline, Circle, Line, Text as SvgText } from 'react-native-svg';
import { Spacing, Radius, FontSize, Shadows } from '../constants';
import { useThemeColor } from '../hooks/useThemeColor';
import { api } from '../services/api';
import type { DailyLog } from '../../shared/types';

interface WeightChartModalProps {
  visible: boolean;
  onClose: () => void;
}

const CHART_H = 200;
const CHART_PADDING_L = 42;
const CHART_PADDING_R = 16;
const CHART_PADDING_T = 16;
const CHART_PADDING_B = 28;

export function WeightChartModal({ visible, onClose }: WeightChartModalProps) {
  const Colors = useThemeColor();
  const [logs, setLogs] = useState<DailyLog[]>([]);
  const [loading, setLoading] = useState(true);

  const screenW = Dimensions.get('window').width;
  const chartW = screenW - Spacing.xl * 2 - Spacing.lg * 2;
  const plotW = chartW - CHART_PADDING_L - CHART_PADDING_R;
  const plotH = CHART_H - CHART_PADDING_T - CHART_PADDING_B;

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    api.getDailyLogs(30).then((res) => {
      if (res.success && res.data) {
        setLogs(res.data as DailyLog[]);
      }
    }).finally(() => setLoading(false));
  }, [visible]);

  // Filter to logs with weight, sorted by date ascending
  const points = useMemo(() => {
    return logs
      .filter((l) => l.weight != null)
      .sort((a, b) => a.log_date.localeCompare(b.log_date));
  }, [logs]);

  const { minW, maxW, yLines } = useMemo(() => {
    if (points.length === 0) return { minW: 0, maxW: 100, yLines: [] };
    const weights = points.map((p) => p.weight!);
    const lo = Math.min(...weights);
    const hi = Math.max(...weights);
    const pad = Math.max((hi - lo) * 0.15, 0.5);
    const min = Math.floor((lo - pad) * 2) / 2;
    const max = Math.ceil((hi + pad) * 2) / 2;
    const step = Math.max(Math.round((max - min) / 4 * 2) / 2, 0.5);
    const lines: number[] = [];
    for (let v = min; v <= max + 0.01; v += step) {
      lines.push(Math.round(v * 10) / 10);
    }
    return { minW: min, maxW: max, yLines: lines };
  }, [points]);

  const toX = (i: number) => CHART_PADDING_L + (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2);
  const toY = (w: number) => CHART_PADDING_T + plotH - ((w - minW) / (maxW - minW || 1)) * plotH;

  const polyPoints = points.map((p, i) => `${toX(i)},${toY(p.weight!)}`).join(' ');

  const latestWeight = points.length > 0 ? points[points.length - 1].weight : null;
  const prevWeight = points.length > 1 ? points[points.length - 2].weight : null;
  const diff = latestWeight != null && prevWeight != null ? latestWeight - prevWeight : null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={[styles.card, { backgroundColor: Colors.surface }]}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={[styles.title, { color: Colors.text }]}>体重趋势</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={Colors.textTertiary} />
            </TouchableOpacity>
          </View>

          {/* Latest stat */}
          {latestWeight != null && (
            <View style={styles.statRow}>
              <Text style={[styles.statValue, { color: Colors.text }]}>{latestWeight} kg</Text>
              {diff != null && diff !== 0 && (
                <View style={[styles.diffBadge, { backgroundColor: diff > 0 ? Colors.dangerLight : Colors.successLight }]}>
                  <Ionicons
                    name={diff > 0 ? 'arrow-up' : 'arrow-down'}
                    size={12}
                    color={diff > 0 ? Colors.danger : Colors.success}
                  />
                  <Text style={[styles.diffText, { color: diff > 0 ? Colors.danger : Colors.success }]}>
                    {Math.abs(diff).toFixed(1)} kg
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* Chart */}
          {loading ? (
            <View style={styles.chartLoading}>
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : points.length < 2 ? (
            <View style={styles.chartLoading}>
              <Text style={[styles.emptyText, { color: Colors.textTertiary }]}>至少需要两天数据才能绘制曲线</Text>
            </View>
          ) : (
            <Svg width={chartW} height={CHART_H}>
              {/* Y-axis grid lines + labels */}
              {yLines.map((v) => {
                const y = toY(v);
                return (
                  <G key={String(v)}>
                    <Line x1={CHART_PADDING_L} y1={y} x2={chartW - CHART_PADDING_R} y2={y} stroke={Colors.borderLight} strokeWidth={1} />
                    <SvgText x={CHART_PADDING_L - 6} y={y + 4} textAnchor="end" fill={Colors.textTertiary} fontSize={10}>
                      {v}
                    </SvgText>
                  </G>
                );
              })}

              {/* Line */}
              <Polyline
                points={polyPoints}
                fill="none"
                stroke={Colors.info}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />

              {/* Dots + date labels */}
              {points.map((p, i) => {
                const x = toX(i);
                const y = toY(p.weight!);
                // Show date labels for first, last, and middle
                const showDate = i === 0 || i === points.length - 1 || (points.length > 4 && i === Math.floor(points.length / 2));
                const dateLabel = p.log_date.slice(5); // MM-DD
                return (
                  <G key={p.id}>
                    <Circle cx={x} cy={y} r={3.5} fill={Colors.info} />
                    {showDate && (
                      <SvgText x={x} y={CHART_H - 6} textAnchor="middle" fill={Colors.textTertiary} fontSize={10}>
                        {dateLabel}
                      </SvgText>
                    )}
                  </G>
                );
              })}
            </Svg>
          )}

          <Text style={[styles.hint, { color: Colors.textTertiary }]}>近 30 天记录</Text>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.xl,
  },
  card: {
    width: '100%',
    borderRadius: Radius.xl,
    padding: Spacing.lg,
    ...Shadows.lg,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  title: {
    fontSize: FontSize.lg,
    fontWeight: '700',
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  statValue: {
    fontSize: FontSize.xxl,
    fontWeight: '700',
  },
  diffBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radius.full,
  },
  diffText: {
    fontSize: FontSize.xs,
    fontWeight: '600',
  },
  chartLoading: {
    height: CHART_H,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    fontSize: FontSize.sm,
  },
  hint: {
    fontSize: FontSize.xs,
    textAlign: 'center',
    marginTop: Spacing.sm,
  },
});
