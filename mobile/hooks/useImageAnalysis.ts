import { useState, useCallback, useRef } from 'react';
import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as Haptics from 'expo-haptics';
import Toast from 'react-native-toast-message';
import { streamSingleRoleAgent } from '../services/agent-stream';
import type { AIRole } from '../../shared/types';

const MAX_IMAGE_DIMENSION = 1600;

export function parseAIJson<T>(raw: string): T | null {
  const candidates: string[] = [];
  const fenceMatches = raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const m of fenceMatches) {
    if (m[1]) candidates.push(m[1].trim());
  }
  candidates.push(raw.trim());

  for (const candidate of candidates) {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) continue;
    try {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as T;
    } catch {
      // try next
    }
  }
  return null;
}

interface UseImageAnalysisOptions {
  role: AIRole;
  buildPrompt: () => string;
  onResult: (rawText: string) => void;
}

export function useImageAnalysis(options: UseImageAnalysisOptions) {
  const { role, buildPrompt, onResult } = options;
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisText, setAnalysisText] = useState('');
  const analyzingRef = useRef(false);

  const resizeImage = async (uri: string) => {
    try {
      const result = await manipulateAsync(
        uri,
        [{ resize: { width: MAX_IMAGE_DIMENSION } }],
        { compress: 0.7, format: SaveFormat.JPEG, base64: true }
      );
      if (!result.base64) return null;
      return { uri: result.uri, base64: result.base64 };
    } catch {
      return null;
    }
  };

  const analyzeImage = useCallback(async (imageUri: string) => {
    if (analyzingRef.current) return;
    analyzingRef.current = true;
    setAnalyzing(true);
    setAnalysisText('');

    try {
      const resized = await resizeImage(imageUri);
      if (!resized) {
        Toast.show({ type: 'error', text1: '图片处理失败' });
        return;
      }

      const imageDataUri = `data:image/jpeg;base64,${resized.base64}`;

      const prompt = buildPrompt();
      const rawText = await new Promise<string>((resolve, reject) => {
        let merged = '';
        void streamSingleRoleAgent({
          role,
          message: prompt,
          imageDataUri,
          onChunk: (chunk) => {
            merged += chunk;
            setAnalysisText(merged);
          },
          onDone: () => resolve(merged),
          onError: (err) => reject(err),
        });
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onResult(rawText);
    } catch {
      Toast.show({ type: 'error', text1: 'AI 分析失败', text2: '请检查网络后重试' });
    } finally {
      setAnalyzing(false);
      analyzingRef.current = false;
    }
  }, [role, buildPrompt, onResult]);

  const pickAndAnalyze = useCallback(() => {
    if (analyzingRef.current) return;

    Alert.alert('AI 图片识别', '选择图片来源', [
      {
        text: '拍照',
        onPress: async () => {
          const { status } = await ImagePicker.requestCameraPermissionsAsync();
          if (status !== 'granted') {
            Toast.show({ type: 'error', text1: '权限不足', text2: '需要相机权限' });
            return;
          }
          const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
          if (!result.canceled && result.assets[0]) {
            analyzeImage(result.assets[0].uri);
          }
        },
      },
      {
        text: '从相册选择',
        onPress: async () => {
          const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (status !== 'granted') {
            Toast.show({ type: 'error', text1: '权限不足', text2: '需要相册访问权限' });
            return;
          }
          const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
          if (!result.canceled && result.assets[0]) {
            analyzeImage(result.assets[0].uri);
          }
        },
      },
      { text: '取消', style: 'cancel' },
    ]);
  }, [analyzeImage]);

  return { pickAndAnalyze, analyzing, analysisText };
}
