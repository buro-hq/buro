/** Expands direct object arguments while preserving comments and other object layouts. */
export const multilineCallObject = {
  meta: {
    type: 'layout',
    docs: { description: 'Put each property of a nonempty object argument on its own line.' },
    fixable: 'whitespace',
    schema: [],
    messages: { multiline: 'Write object argument properties on separate lines.' },
  },
  create(context) {
    const { sourceCode } = context;

    return {
      ObjectExpression(node) {
        const { properties } = node;
        let argument = node;
        const wrappers = ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion'];

        while (wrappers.includes(argument.parent.type))
          argument = argument.parent;

        const { parent } = argument;
        const isCall = parent.type === 'CallExpression' || parent.type === 'NewExpression';

        if (!isCall || !parent.arguments.includes(argument) || !properties.length)
          return;

        const open = sourceCode.getFirstToken(node);
        const close = sourceCode.getLastToken(node);
        const after = [];

        if (open.loc.end.line === properties[0].loc.start.line)
          after.push(open);

        for (let index = 1; index < properties.length; index++) {
          const comma = sourceCode.getTokenAfter(properties[index - 1]);

          if (comma.loc.end.line === properties[index].loc.start.line)
            after.push(comma);
        }

        const beforeClose = properties.at(-1).loc.end.line === close.loc.start.line;

        if (!after.length && !beforeClose)
          return;

        context.report({
          node,
          messageId: 'multiline',
          fix: (fixer) => [
            ...after.map((token) => fixer.insertTextAfter(token, '\n')),
            ...(beforeClose ? [fixer.insertTextBefore(close, '\n')] : []),
          ],
        });
      },
    };
  },
};
