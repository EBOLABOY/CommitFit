import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { FontSize } from '../../constants';
import { useThemeColor } from '../../hooks/useThemeColor';

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
          height: 60,
          backgroundColor: Colors.surface,
          borderTopColor: Colors.borderLight,
        },
        tabBarLabelStyle: { fontSize: FontSize.xs, fontWeight: '500' },
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
          tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="ai"
        options={{
          headerShown: false,
          title: 'AI 咨询',
          tabBarIcon: ({ color, size }) => <Ionicons name="chatbubbles" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="plans"
        options={{
          title: '营养',
          tabBarIcon: ({ color, size }) => <Ionicons name="nutrition" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: '我的',
          tabBarIcon: ({ color, size }) => <Ionicons name="person" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
