import { useColorScheme } from 'react-native';
import { LightColors, DarkColors, ThemeColors } from '../constants';

export function useThemeColor(): ThemeColors {
    const theme = useColorScheme();
    return theme === 'dark' ? DarkColors : LightColors;
}
