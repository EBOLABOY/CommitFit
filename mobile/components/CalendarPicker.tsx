import { useState, useMemo, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Spacing, Radius, FontSize } from '../constants';
import { useThemeColor } from '../hooks/useThemeColor';

interface CalendarPickerProps {
  selectedDate: string;                // YYYY-MM-DD
  onSelectDate: (date: string) => void;
  markedDates?: Set<string>;           // 有数据的日期（显示小圆点）
  accentColor?: string;                // 选中态颜色，默认 primary
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function toDateStr(y: number, m: number, d: number): string {
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

function todayStr(): string {
  const d = new Date();
  return toDateStr(d.getFullYear(), d.getMonth(), d.getDate());
}

export function CalendarPicker({ selectedDate, onSelectDate, markedDates, accentColor }: CalendarPickerProps) {
  const Colors = useThemeColor();
  const accent = accentColor || Colors.primary;
  const today = todayStr();

  // Parse selectedDate to determine initial display month
  const [displayYear, setDisplayYear] = useState(() => {
    const parts = selectedDate.split('-');
    return parseInt(parts[0], 10) || new Date().getFullYear();
  });
  const [displayMonth, setDisplayMonth] = useState(() => {
    const parts = selectedDate.split('-');
    return (parseInt(parts[1], 10) || new Date().getMonth() + 1) - 1; // 0-indexed
  });

  const goToPrevMonth = useCallback(() => {
    setDisplayMonth((m) => {
      if (m === 0) {
        setDisplayYear((y) => y - 1);
        return 11;
      }
      return m - 1;
    });
  }, []);

  const goToNextMonth = useCallback(() => {
    setDisplayMonth((m) => {
      if (m === 11) {
        setDisplayYear((y) => y + 1);
        return 0;
      }
      return m + 1;
    });
  }, []);

  // Build the grid of day cells for the display month
  const dayCells = useMemo(() => {
    const firstDay = new Date(displayYear, displayMonth, 1).getDay(); // 0=Sun
    const daysInMonth = new Date(displayYear, displayMonth + 1, 0).getDate();
    const cells: (number | null)[] = [];
    for (let i = 0; i < firstDay; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    return cells;
  }, [displayYear, displayMonth]);

  const monthLabel = `${displayYear}年${displayMonth + 1}月`;

  return (
    <View style={[styles.container, { backgroundColor: Colors.surface, borderColor: Colors.borderLight }]}>
      {/* Month navigation */}
      <View style={styles.header}>
        <TouchableOpacity onPress={goToPrevMonth} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={[styles.monthLabel, { color: Colors.text }]}>{monthLabel}</Text>
        <TouchableOpacity onPress={goToNextMonth} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-forward" size={22} color={Colors.text} />
        </TouchableOpacity>
      </View>

      {/* Weekday labels */}
      <View style={styles.weekRow}>
        {WEEKDAY_LABELS.map((label) => (
          <View key={label} style={styles.weekCell}>
            <Text style={[styles.weekLabel, { color: Colors.textTertiary }]}>{label}</Text>
          </View>
        ))}
      </View>

      {/* Day grid */}
      <View style={styles.dayGrid}>
        {dayCells.map((day, idx) => {
          if (day === null) {
            return <View key={`empty-${idx}`} style={styles.dayCell} />;
          }
          const dateStr = toDateStr(displayYear, displayMonth, day);
          const isSelected = dateStr === selectedDate;
          const isToday = dateStr === today;
          const isMarked = markedDates?.has(dateStr);

          return (
            <TouchableOpacity
              key={dateStr}
              style={styles.dayCell}
              onPress={() => onSelectDate(dateStr)}
              activeOpacity={0.6}
            >
              <View style={[
                styles.dayInner,
                isSelected && { backgroundColor: accent },
              ]}>
                <Text style={[
                  styles.dayText,
                  { color: Colors.text },
                  isToday && !isSelected && { color: accent, fontWeight: '700' },
                  isSelected && styles.dayTextSelected,
                ]}>
                  {day}
                </Text>
              </View>
              {isMarked && !isSelected && (
                <View style={[styles.dot, { backgroundColor: accent }]} />
              )}
              {isMarked && isSelected && (
                <View style={[styles.dot, { backgroundColor: '#FFFFFF' }]} />
              )}
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const DAY_CELL_SIZE = `${100 / 7}%` as unknown as number;

const styles = StyleSheet.create({
  container: {
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    borderWidth: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.md,
    paddingHorizontal: Spacing.xs,
  },
  monthLabel: {
    fontSize: FontSize.lg,
    fontWeight: '700',
  },
  weekRow: {
    flexDirection: 'row',
    marginBottom: Spacing.xs,
  },
  weekCell: {
    width: DAY_CELL_SIZE,
    alignItems: 'center',
    paddingVertical: Spacing.xs,
  },
  weekLabel: {
    fontSize: FontSize.xs,
    fontWeight: '600',
  },
  dayGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dayCell: {
    width: DAY_CELL_SIZE,
    alignItems: 'center',
    paddingVertical: 2,
    height: 44,
    justifyContent: 'center',
  },
  dayInner: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayText: {
    fontSize: FontSize.sm,
    fontWeight: '400',
  },
  dayTextSelected: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    position: 'absolute',
    bottom: 2,
  },
});
