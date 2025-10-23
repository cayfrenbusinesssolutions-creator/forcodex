/*
README
- Accounts-AI is an Expo + React Native chat client wired to an n8n webhook.
- Messages are kept in memory and cleared when the app restarts.
- dont make binary files . just give me tsx
*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
  NativeSyntheticEvent,
  TextInputKeyPressEventData,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';
import * as Network from 'expo-network';
import { LinearGradient } from 'expo-linear-gradient';

const WEBHOOK_URL = 'https://quincy-unsyllogistic-carl.ngrok-free.dev/webhook/30a199d8-33f4-4416-899e-e6f0bf253075';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const BEEP_SOUND_URL = 'https://actions.google.com/sounds/v1/alarms/beep_short.ogg';

type Role = 'user' | 'bot' | 'system';

type ChatMessage = {
  id: string;
  role: Role;
  text: string;
  pending?: boolean;
  isError?: boolean;
  isBinary?: boolean;
  fileName?: string;
  fileSize?: number;
  fileUri?: string;
  mimeType?: string;
  retryPayload?: SendPayload;
};

type SendPayload = {
  text: string;
  file?: DocumentPicker.DocumentPickerAsset | null;
};

type BinaryResponse = {
  fileUri: string;
  fileName: string;
  mimeType: string;
  fileSize?: number;
};

type DocumentPickerAssetWithFile = DocumentPicker.DocumentPickerAsset & { file?: any };

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  const base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let result = '';
  let i: number;

  for (i = 0; i < bytes.length; i += 3) {
    const byte1 = bytes[i];
    const byte2 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const byte3 = i + 2 < bytes.length ? bytes[i + 2] : 0;

    const enc1 = byte1 >> 2;
    const enc2 = ((byte1 & 3) << 4) | (byte2 >> 4);
    let enc3 = ((byte2 & 15) << 2) | (byte3 >> 6);
    let enc4 = byte3 & 63;

    if (i + 1 >= bytes.length) {
      enc3 = 64;
      enc4 = 64;
    } else if (i + 2 >= bytes.length) {
      enc4 = 64;
    }

    result +=
      base64Chars.charAt(enc1) +
      base64Chars.charAt(enc2) +
      base64Chars.charAt(enc3) +
      base64Chars.charAt(enc4);
  }

  return result;
};

const formatBytes = (bytes: number | undefined) => {
  if (typeof bytes !== 'number') return '';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
};

const getFilenameFromContentDisposition = (contentDisposition: string | null): string | null => {
  if (!contentDisposition) return null;
  const match = contentDisposition.match(/filename\*=UTF-8''([^;\n]+)/i) || contentDisposition.match(/filename="?([^";]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
};

const useReplyFeedback = () => {
  const soundRef = useRef<Audio.Sound | null>(null);

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const { sound } = await Audio.Sound.createAsync({ uri: BEEP_SOUND_URL });
        if (isMounted) {
          soundRef.current = sound;
        } else {
          await sound.unloadAsync();
        }
      } catch (error) {
        console.warn('Failed to load sound', error);
      }
    })();

    return () => {
      isMounted = false;
      if (soundRef.current) {
        soundRef.current.unloadAsync();
      }
    };
  }, []);

  return useCallback(async () => {
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
      if (soundRef.current) {
        await soundRef.current.replayAsync();
      }
    } catch (error) {
      console.warn('Feedback failed', error);
    }
  }, []);
};

const useNetworkStatus = () => {
  const [isOnline, setIsOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let subscription: Network.NetworkStateSubscription | null = null;

    const fetchState = async () => {
      try {
        const state = await Network.getNetworkStateAsync();
        setIsOnline(Boolean(state.isConnected && state.isInternetReachable));
      } catch (error) {
        console.warn('Network state error', error);
        setIsOnline(false);
      }
    };

    fetchState();

    Network.addNetworkStateListener &&
      (subscription = Network.addNetworkStateListener((state) => {
        setIsOnline(Boolean(state.isConnected && state.isInternetReachable));
      }));

    return () => {
      subscription?.remove();
    };
  }, []);

  return isOnline;
};

const ChatBubble: React.FC<{
  message: ChatMessage;
  onRetry?: (payload?: SendPayload) => void;
  onDownload?: (message: ChatMessage) => void;
  isDarkMode?: boolean;
}> = ({ message, onRetry, onDownload, isDarkMode }) => {
  const isUser = message.role === 'user';
  const alignment = isUser ? 'flex-end' : 'flex-start';
  const bubbleColor = isUser ? '#0b7dda' : isDarkMode ? '#1f2937' : '#eef1f5';
  const textColor = message.isError
    ? '#b91c1c'
    : isUser
    ? '#ffffff'
    : isDarkMode
    ? '#f3f4f6'
    : '#1c1c1e';

  return (
    <View style={[styles.messageWrapper, { alignItems: alignment }]}>
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: message.isError ? '#f8d7da' : bubbleColor,
            borderTopRightRadius: isUser ? 2 : 14,
            borderTopLeftRadius: isUser ? 14 : 2,
          },
        ]}
      >
        <Text style={[styles.messageText, { color: textColor }]}>{message.text}</Text>
        {message.fileName && (
          <View style={styles.fileMetaRow}>
            <Text style={[styles.fileMetaText, { color: textColor }]}>📄 {message.fileName}</Text>
            {typeof message.fileSize === 'number' && (
              <Text style={[styles.fileMetaSize, { color: textColor }]}>{formatBytes(message.fileSize)}</Text>
            )}
          </View>
        )}
        {message.pending && (
          <View style={styles.typingRow}>
            <ActivityIndicator size="small" color={isUser ? '#fff' : '#0b7dda'} />
            <Text style={[styles.typingText, { color: textColor }]}>Typing…</Text>
          </View>
        )}
        {message.isBinary && message.fileName && (
          <Pressable style={styles.downloadButton} onPress={() => onDownload?.(message)}>
            <Text style={styles.downloadButtonText}>Download {message.fileName}</Text>
          </Pressable>
        )}
      </View>
      {message.isError && message.retryPayload && onRetry && (
        <Pressable onPress={() => onRetry(message.retryPayload)} style={styles.retryButton}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </Pressable>
      )}
    </View>
  );
};

const AccountsAIApp: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [selectedFile, setSelectedFile] = useState<DocumentPicker.DocumentPickerAsset | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const isOnline = useNetworkStatus();
  const colorScheme = useColorScheme();
  const scrollViewRef = useRef<ScrollView>(null);
  const webObjectUrls = useRef<string[]>([]);
  const triggerFeedback = useReplyFeedback();

  const themeStyles = useMemo(() => {
    const isDark = colorScheme === 'dark';
    return {
      backgroundGradient: isDark
        ? ['#0f172a', '#111827']
        : ['#f3f4f6', '#ffffff'],
      composerBackground: isDark ? '#111827' : '#ffffff',
      textPrimary: isDark ? '#f9fafb' : '#111827',
      subtitle: isDark ? '#9ca3af' : '#6b7280',
      divider: isDark ? '#374151' : '#e5e7eb',
      inputBackground: isDark ? '#1f2937' : '#f9fafb',
      inputBorder: isDark ? '#374151' : '#cbd5f5',
    };
  }, [colorScheme]);

  const isDarkMode = colorScheme === 'dark';
  const connectionBadgeColor = isOnline === null ? '#e0e7ff' : isOnline ? '#dcfce7' : '#fee2e2';
  const connectionTextColor = isOnline === null ? '#312e81' : isOnline ? '#065f46' : '#991b1b';
  const connectionLabel =
    isOnline === null ? 'Checking connection…' : isOnline ? 'Connected.' : 'No internet connection.';

  useEffect(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [messages.length]);

  useEffect(() => {
    return () => {
      if (Platform.OS === 'web') {
        webObjectUrls.current.forEach((uri) => URL.revokeObjectURL(uri));
        webObjectUrls.current = [];
      }
    };
  }, []);

  const addMessage = useCallback((message: ChatMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const updateMessage = useCallback((id: string, updater: (msg: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((msg) => (msg.id === id ? updater(msg) : msg)));
  }, []);

  const pickFile = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
        multiple: false,
        copyToCacheDirectory: true,
      });

      if (result.type === 'cancel') {
        return;
      }

      const asset = result.assets?.[0];
      if (!asset) return;

      if (asset.size && asset.size > MAX_FILE_SIZE) {
        setErrorBanner('File too large — maximum allowed size is 5 MB.');
        return;
      }

      setSelectedFile(asset);
      setErrorBanner(null);
    } catch (error) {
      console.warn('File pick error', error);
      setErrorBanner('File upload failed. Please try again.');
    }
  }, []);

  const prepareBinaryResponse = useCallback(
    async (response: Response): Promise<BinaryResponse> => {
      const mimeType = response.headers.get('content-type') || 'application/octet-stream';
      const suggestedName = getFilenameFromContentDisposition(response.headers.get('content-disposition'));
      const extension = mimeType.includes('pdf') ? 'pdf' : 'xlsx';
      const fileName = suggestedName || `AccountsAI-${Date.now()}.${extension}`;

      if (Platform.OS === 'web') {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        webObjectUrls.current.push(url);
        return { fileUri: url, fileName, mimeType, fileSize: blob.size };
      }

      const buffer = await response.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      const fileUri = `${FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? ''}${fileName}`;
      await FileSystem.writeAsStringAsync(fileUri, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      return { fileUri, fileName, mimeType, fileSize: buffer.byteLength };
    },
    [webObjectUrls]
  );

  const handleDownload = useCallback(async (message: ChatMessage) => {
    if (!message.fileUri) return;
    try {
      if (Platform.OS === 'web') {
        await Linking.openURL(message.fileUri);
      } else {
        const isSharingAvailable = await Sharing.isAvailableAsync();
        if (isSharingAvailable) {
          await Sharing.shareAsync(message.fileUri, { mimeType: message.mimeType, dialogTitle: message.fileName });
        } else {
          Alert.alert('Download ready', `Saved to: ${message.fileUri}`);
        }
      }
    } catch (error) {
      Alert.alert('Download failed', 'Unable to share the file at this time.');
    }
  }, []);

  const submitMessage = useCallback(
    async (payload?: SendPayload) => {
      const text = payload?.text ?? inputText.trim();
      const file = payload?.file ?? selectedFile;

      if (isSending) {
        return;
      }

      if (!text && !file) {
        setErrorBanner('Please enter a message before sending.');
        return;
      }

      if (isOnline === false) {
        setErrorBanner('No internet connection.');
        return;
      }

      if (file?.size && file.size > MAX_FILE_SIZE) {
        setErrorBanner('File too large — maximum allowed size is 5 MB.');
        return;
      }

      setErrorBanner(null);

      const userMessageId = `user-${Date.now()}`;
      const botMessageId = `bot-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const userMessage: ChatMessage = {
        id: userMessageId,
        role: 'user',
        text: text || (file ? `Sent file: ${file.name}` : ''),
        fileName: file?.name,
        fileSize: file?.size,
        fileUri: file?.uri,
      };

      const botPlaceholder: ChatMessage = {
        id: botMessageId,
        role: 'bot',
        text: 'Waiting for Accounts-AI…',
        pending: true,
      };

      addMessage(userMessage);
      addMessage(botPlaceholder);
      setInputText('');
      setSelectedFile(null);
      setIsSending(true);
      setTyping(true);

      const formData = new FormData();
      const safeMessage = text || ' ';
      formData.append('message', safeMessage);

      if (file) {
        const fileMimeType =
          file.mimeType ||
          (file.name?.endsWith('.pdf')
            ? 'application/pdf'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

        if (Platform.OS === 'web') {
          const webFile = (file as DocumentPickerAssetWithFile).file;
          if (webFile) {
            formData.append('file', webFile);
          }
        } else {
          formData.append('file', {
            uri: file.uri,
            name: file.name || 'attachment',
            type: fileMimeType,
          } as any);
        }
      }

      let didTimeout = false;
      const timeoutId = setTimeout(() => {
        didTimeout = true;
        setTyping(false);
        setIsSending(false);
        updateMessage(botMessageId, (msg) => ({
          ...msg,
          pending: false,
          isError: true,
          text: 'No response received. Please try again later.',
          retryPayload: { text, file },
        }));
      }, 60000);

      try {
        const response = await fetch(WEBHOOK_URL, {
          method: 'POST',
          body: formData,
        });

        clearTimeout(timeoutId);
        if (didTimeout) {
          return;
        }
        setTyping(false);
        setIsSending(false);

        if (!response.ok) {
          updateMessage(botMessageId, (msg) => ({
            ...msg,
            pending: false,
            isError: true,
            text: 'Something went wrong. Please try again.',
            retryPayload: { text, file },
          }));
          return;
        }

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/pdf') || contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') || contentType.includes('application/octet-stream')) {
          const binary = await prepareBinaryResponse(response);
          updateMessage(botMessageId, (msg) => ({
            ...msg,
            pending: false,
            isError: false,
            isBinary: true,
            text: 'Document ready for download.',
            fileName: binary.fileName,
            fileUri: binary.fileUri,
            mimeType: binary.mimeType,
            fileSize: binary.fileSize,
          }));
        } else {
          const textResponse = await response.text();
          updateMessage(botMessageId, (msg) => ({
            ...msg,
            pending: false,
            isError: false,
            text: textResponse,
          }));
        }

        triggerFeedback();
      } catch (error) {
        console.warn('Send error', error);
        clearTimeout(timeoutId);
        if (didTimeout) {
          return;
        }
        setTyping(false);
        setIsSending(false);
        updateMessage(botMessageId, (msg) => ({
          ...msg,
          pending: false,
          isError: true,
          text: 'Something went wrong. Please try again.',
          retryPayload: { text, file },
        }));
      }
    },
    [addMessage, inputText, isOnline, isSending, prepareBinaryResponse, selectedFile, triggerFeedback, updateMessage]
  );

  const handleRetry = useCallback(
    (payload?: SendPayload) => {
      if (!payload) return;
      submitMessage(payload);
    },
    [submitMessage]
  );

  const handleComposerKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (Platform.OS === 'web') {
        if (event.nativeEvent.key === 'Enter' && !event.nativeEvent.shiftKey) {
          event.preventDefault();
          submitMessage();
        }
      }
    },
    [submitMessage]
  );

  const sendButtonLabel = isSending ? 'Sending…' : 'Send';

  return (
    <LinearGradient colors={themeStyles.backgroundGradient} style={styles.root}>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <KeyboardAvoidingView
        style={styles.keyboardAvoiding}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 0}
      >
        <View style={styles.header}>
          <View style={styles.headerTextContainer}>
            <Text style={[styles.title, { color: themeStyles.textPrimary }]}>Accounts-AI</Text>
            <Text style={[styles.subtitle, { color: themeStyles.subtitle }]}>Create invoices, quotes, purchase orders, and bills using simple text messages.</Text>
            <View style={[styles.connectionBadge, { backgroundColor: connectionBadgeColor }]}>
              <Text style={{ color: connectionTextColor }}>{connectionLabel}</Text>
            </View>
          </View>
        </View>

        <View style={styles.chatContainer}>
          <ScrollView
            ref={scrollViewRef}
            contentContainerStyle={styles.messagesContainer}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {messages.map((message) => (
              <ChatBubble
                key={message.id}
                message={message}
                onRetry={(payload) => handleRetry(payload ?? message.retryPayload)}
                onDownload={handleDownload}
                isDarkMode={isDarkMode}
              />
            ))}
            {typing && (
              <View style={styles.typingIndicator}>
                <ActivityIndicator size="small" color="#0b7dda" />
                <Text style={[styles.typingIndicatorText, { color: isDarkMode ? '#d1d5db' : '#4b5563' }]}>Accounts-AI is typing…</Text>
              </View>
            )}
          </ScrollView>
        </View>

        <View style={[styles.composerContainer, { backgroundColor: themeStyles.composerBackground, borderTopColor: themeStyles.divider }]}>
          {selectedFile && (
            <View style={[styles.attachmentPreview, { backgroundColor: isDarkMode ? '#374151' : '#e5e7eb' }]}> 
              <Text style={[styles.attachmentText, { color: isDarkMode ? '#f3f4f6' : '#111827' }]}>{selectedFile.name}</Text>
              <Text style={[styles.attachmentMeta, { color: isDarkMode ? '#d1d5db' : '#4b5563' }]}>{formatBytes(selectedFile.size)}</Text>
              <Pressable onPress={() => setSelectedFile(null)} style={styles.removeAttachmentButton}>
                <Text style={styles.removeAttachmentText}>Remove</Text>
              </Pressable>
            </View>
          )}
          {errorBanner && (
            <View style={[styles.errorBanner, { backgroundColor: isDarkMode ? '#7f1d1d' : '#fee2e2' }]}>
              <Text style={[styles.errorText, { color: isDarkMode ? '#fecaca' : '#991b1b' }]}>{errorBanner}</Text>
            </View>
          )}
          <View style={styles.composerRow}>
            <Pressable
              onPress={pickFile}
              style={[styles.attachButton, { backgroundColor: isDarkMode ? '#374151' : '#e5e7eb' }]}
            >
              <Text style={[styles.attachButtonLabel, { color: isDarkMode ? '#f3f4f6' : '#111827' }]}>Attach</Text>
            </Pressable>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: themeStyles.inputBackground,
                  borderColor: themeStyles.inputBorder,
                  color: themeStyles.textPrimary,
                },
              ]}
              multiline
              placeholder="Type your message…"
              placeholderTextColor={isDarkMode ? '#6b7280' : '#9ca3af'}
              value={inputText}
              onChangeText={setInputText}
              onKeyPress={handleComposerKeyPress}
              onSubmitEditing={() => {
                if (Platform.OS !== 'web') {
                  submitMessage();
                }
              }}
              returnKeyType="send"
              blurOnSubmit={false}
            />
            <Pressable
              onPress={() => submitMessage()}
              style={[styles.sendButton, { backgroundColor: isSending ? '#22c55e' : '#0b7dda', opacity: isOnline === false ? 0.5 : 1 }]}
              disabled={isSending || isOnline === false}
            >
              <Text style={styles.sendButtonLabel}>{sendButtonLabel}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  keyboardAvoiding: {
    flex: 1,
  },
  header: {
    paddingTop: 48,
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  headerTextContainer: {
    gap: 8,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
  },
  connectionBadge: {
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  chatContainer: {
    flex: 1,
    paddingHorizontal: 16,
  },
  messagesContainer: {
    paddingBottom: 24,
    gap: 12,
  },
  messageWrapper: {
    width: '100%',
  },
  bubble: {
    maxWidth: '85%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    gap: 8,
  },
  messageText: {
    fontSize: 16,
    lineHeight: 22,
  },
  typingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  typingText: {
    fontSize: 14,
  },
  fileMetaRow: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fileMetaText: {
    fontSize: 14,
    fontWeight: '600',
  },
  fileMetaSize: {
    fontSize: 12,
    opacity: 0.85,
  },
  typingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  typingIndicatorText: {
    fontSize: 14,
    color: '#4b5563',
  },
  composerContainer: {
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 12,
  },
  input: {
    flex: 1,
    maxHeight: 140,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#cbd5f5',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    backgroundColor: '#f9fafb',
  },
  attachButton: {
    backgroundColor: '#e5e7eb',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
  },
  attachButtonLabel: {
    fontWeight: '600',
    color: '#111827',
  },
  sendButton: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 14,
  },
  sendButtonLabel: {
    color: '#ffffff',
    fontWeight: '600',
  },
  attachmentPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: '#e5e7eb',
    marginBottom: 8,
  },
  attachmentText: {
    flex: 1,
    fontWeight: '600',
  },
  attachmentMeta: {
    marginHorizontal: 8,
    color: '#4b5563',
  },
  removeAttachmentButton: {
    padding: 6,
  },
  removeAttachmentText: {
    color: '#dc2626',
    fontWeight: '600',
  },
  errorBanner: {
    backgroundColor: '#fee2e2',
    padding: 10,
    borderRadius: 10,
    marginBottom: 8,
  },
  errorText: {
    color: '#991b1b',
  },
  retryButton: {
    marginTop: 4,
    alignSelf: 'flex-end',
    backgroundColor: '#f97316',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
  },
  retryButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  downloadButton: {
    marginTop: 6,
    backgroundColor: '#22c55e',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  downloadButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
});

export default AccountsAIApp;
