import React, { useMemo } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

import { parseMarkdown, stripMarkdown, type InlineToken } from '../../lib/markdown';

interface MarkdownTextProps {
  children: string;
  /** Base text style — the parser only adds weight/style/family on top. */
  style?: StyleProp<TextStyle>;
}

/**
 * Renders the chat coach's Markdown subset.
 *
 * Everything inherits from `style`, so a bubble keeps its own colour and size
 * and this only layers emphasis on top — otherwise the coach bubble and the
 * user bubble would need separate copies of the renderer.
 */
export function MarkdownText({ children, style }: MarkdownTextProps) {
  const blocks = useMemo(() => parseMarkdown(children), [children]);

  // Nothing to lay out — render a single Text so short replies (the common
  // case) don't pay for a wrapping View.
  if (blocks.length === 1 && blocks[0].type === 'paragraph') {
    return (
      <Text style={style} accessibilityLabel={stripMarkdown(children)}>
        {blocks[0].spans.map(renderSpan)}
      </Text>
    );
  }

  return (
    <View accessible accessibilityLabel={stripMarkdown(children)}>
      {blocks.map((block, i) => {
        const spacing = i === 0 ? undefined : s.blockGap;

        if (block.type === 'paragraph') {
          return (
            <Text key={i} style={[style, spacing]}>
              {block.spans.map(renderSpan)}
            </Text>
          );
        }

        // Marker in its own Text so wrapped lines indent under the text rather
        // than back under the bullet.
        const marker = block.type === 'bullet' ? '•' : block.marker;
        return (
          <View key={i} style={[s.listRow, spacing]}>
            <Text style={[style, s.marker]}>{marker}</Text>
            <Text style={[style, s.listText]}>{block.spans.map(renderSpan)}</Text>
          </View>
        );
      })}
    </View>
  );
}

function renderSpan(token: InlineToken, i: number) {
  switch (token.type) {
    case 'bold':
      return <Text key={i} style={s.bold}>{token.text}</Text>;
    case 'italic':
      return <Text key={i} style={s.italic}>{token.text}</Text>;
    case 'boldItalic':
      return <Text key={i} style={[s.bold, s.italic]}>{token.text}</Text>;
    case 'code':
      return <Text key={i} style={s.code}>{token.text}</Text>;
    default:
      return <Text key={i}>{token.text}</Text>;
  }
}

const s = StyleSheet.create({
  blockGap: { marginTop: 6 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  code: { fontFamily: 'Menlo', fontSize: 13 },
  listRow: { flexDirection: 'row' },
  marker: { width: 18 },
  listText: { flex: 1 },
});
