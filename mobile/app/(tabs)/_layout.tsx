import { View } from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { FontSize } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';

// 选中态圆点指示器
function TabIcon({ name, color, size, focused }: { name: keyof typeof Ionicons.glyphMap; color: string; size: number; focused: boolean }) {
  const Colors = useThemeColor();
  return (
    <View style={{ alignItems: 'center' }}>
      <Ionicons name={name} size={size} color={color} />
      {focused && (
        <View
          style={{
            width: 5,
            height: 5,
            borderRadius: 2.5,
            backgroundColor: Colors.primary,
            marginTop: 3,
          }}
        />
      )}
    </View>
  );
}

export default function TabsLayout() {
  const Colors = useThemeColor();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors.primary,
        tabBarInactiveTintColor: Colors.textTertiary,
        tabBarStyle: {
          paddingBottom: 8,
          paddingTop: 4,
          height: 64,
          backgroundColor: Colors.surface,
          borderTopColor: Colors.borderLight,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: -2 },
          shadowOpacity: 0.04,
          shadowRadius: 8,
          elevation: 4,
        },
        tabBarLabelStyle: { fontSize: FontSize.xs, fontWeight: '600', marginTop: -2 },
        headerStyle: { backgroundColor: Colors.background },
        headerTitleStyle: { fontWeight: '700', color: Colors.text },
        headerShadowVisible: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          headerShown: false,
          title: '首页',
          tabBarIcon: ({ color, size, focused }) => <TabIcon name="home" color={color} size={size} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="ai"
        options={{
          headerShown: false,
          title: 'AI 咨询',
          tabBarIcon: ({ color, size, focused }) => <TabIcon name="chatbubbles" color={color} size={size} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: '我的',
          tabBarIcon: ({ color, size, focused }) => <TabIcon name="person" color={color} size={size} focused={focused} />,
        }}
      />
    </Tabs>
  );
}
