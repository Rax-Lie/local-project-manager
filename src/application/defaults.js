'use strict';

/**
 * 首次初始化的内置模板。模板 JSON 是内容真相，升级不会回写既有项目快照。
 * 变量由 domain/template.renderMarkdown 严格校验，未知变量会被拒绝。
 */
const DEFAULT_TEMPLATES = Object.freeze([
  {
    id: 'standard',
    revision: 1,
    displayName: '通用项目',
    fields: [
      {
        id: 'description',
        label: '项目说明',
        type: 'text',
        required: false,
        defaultValue: ''
      },
      {
        id: 'owner',
        label: '负责人',
        type: 'text',
        required: false,
        defaultValue: ''
      },
      {
        id: 'startDate',
        label: '开始日期',
        type: 'date',
        required: false,
        defaultValue: null
      },
      {
        id: 'priority',
        label: '优先级',
        type: 'choice',
        required: true,
        choices: ['低', '中', '高'],
        defaultValue: '中'
      }
    ],
    directoryBlueprint: ['docs', 'docs/notes', 'assets'],
    markdownTemplates: [
      {
        id: 'readme',
        displayName: '项目 README',
        targetPath: 'README.md',
        content: [
          '# ${project.displayName}',
          '',
          '> 由通用项目管理扩展创建。',
          '',
          '- 目录 slug：`${project.slug}`',
          '- 创建时间：${project.createdAt}',
          '- 管理根：${root.displayName}',
          '',
          '## 说明',
          '',
          '${field.description}',
          '',
          '## 负责人',
          '',
          '${field.owner}',
          ''
        ].join('\n')
      }
    ]
  },
  {
    id: 'blank',
    revision: 1,
    displayName: '空白项目',
    fields: [],
    directoryBlueprint: ['docs'],
    markdownTemplates: [
      {
        id: 'readme',
        displayName: '项目 README',
        targetPath: 'README.md',
        content: [
          '# ${project.displayName}',
          '',
          '- 目录 slug：`${project.slug}`',
          '- 创建时间：${project.createdAt}',
          ''
        ].join('\n')
      }
    ]
  }
]);

module.exports = {
  DEFAULT_TEMPLATES
};
