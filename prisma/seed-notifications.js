import { prisma } from '../src/lib/prisma.js';

const templates = [
  // ── Task Category ──
  { slug: 'task_created', name: 'Task Created', description: 'When a new task is created', category: 'task',
    subject: 'New Task: {{taskTitle}} [{{projectName}}]',
    bodyHtml: '<p>A new task <strong>{{taskTitle}}</strong> has been created in project <strong>{{projectName}}</strong>.</p>',
    bodyText: 'A new task "{{taskTitle}}" has been created in project "{{projectName}}".',
    inAppMessage: 'New task created: {{taskTitle}}',
    variables: ['taskTitle', 'projectName', 'assignedBy', 'actionUrl'] },

  { slug: 'task_assigned', name: 'Task Assigned', description: 'When a user is assigned to a task', category: 'task',
    subject: '{{assignedBy}} assigned you to: {{taskTitle}} [{{projectName}}]',
    bodyHtml: '<p><strong>{{assignedBy}}</strong> assigned you to task <strong>{{taskTitle}}</strong> in project <strong>{{projectName}}</strong>.</p>',
    bodyText: '{{assignedBy}} assigned you to task "{{taskTitle}}" in project "{{projectName}}".',
    inAppMessage: 'You were assigned to: {{taskTitle}}',
    variables: ['taskTitle', 'projectName', 'assignedBy', 'actionUrl'] },

  { slug: 'task_unassigned', name: 'Task Unassigned', description: 'When a user is removed from a task', category: 'task',
    subject: 'Removed from task: {{taskTitle}}',
    bodyHtml: '<p>You have been removed from task <strong>{{taskTitle}}</strong> in project <strong>{{projectName}}</strong>.</p>',
    bodyText: 'You have been removed from task "{{taskTitle}}" in project "{{projectName}}".',
    inAppMessage: 'You were removed from: {{taskTitle}}',
    variables: ['taskTitle', 'projectName', 'changedBy', 'actionUrl'] },

  { slug: 'task_status_changed', name: 'Task Status Changed', description: 'When a task status is updated', category: 'task',
    subject: 'Task "{{taskTitle}}" status changed to {{newStatus}}',
    bodyHtml: '<p>Task <strong>{{taskTitle}}</strong> status changed from <em>{{oldStatus}}</em> to <strong>{{newStatus}}</strong> by {{changedBy}}.</p>',
    bodyText: 'Task "{{taskTitle}}" status changed from {{oldStatus}} to {{newStatus}} by {{changedBy}}.',
    inAppMessage: 'Task "{{taskTitle}}" \u2192 {{newStatus}}',
    variables: ['taskTitle', 'projectName', 'oldStatus', 'newStatus', 'changedBy', 'actionUrl'] },

  { slug: 'task_completed', name: 'Task Completed', description: 'When a task is marked as completed', category: 'task',
    subject: 'Task Completed: {{taskTitle}} [{{projectName}}]',
    bodyHtml: '<p>Task <strong>{{taskTitle}}</strong> in project <strong>{{projectName}}</strong> has been completed by {{completedBy}}.</p>',
    bodyText: 'Task "{{taskTitle}}" in project "{{projectName}}" has been completed by {{completedBy}}.',
    inAppMessage: 'Task completed: {{taskTitle}}',
    variables: ['taskTitle', 'projectName', 'completedBy', 'actionUrl'] },

  { slug: 'task_overdue', name: 'Task Overdue', description: 'When a task is past its due date', category: 'task',
    subject: 'Overdue: {{taskTitle}} [{{projectName}}]',
    bodyHtml: '<p>Task <strong>{{taskTitle}}</strong> in project <strong>{{projectName}}</strong> is overdue!</p>',
    bodyText: 'Task "{{taskTitle}}" in project "{{projectName}}" is overdue!',
    inAppMessage: "Task '{{taskTitle}}' is overdue!",
    variables: ['taskTitle', 'projectName', 'actionUrl'] },

  { slug: 'task_stagnant', name: 'Task Stagnant', description: 'When a task has been unchanged for 3+ days', category: 'task',
    subject: 'Stagnant Task: {{taskTitle}} [{{projectName}}]',
    bodyHtml: '<p>Task <strong>{{taskTitle}}</strong> in project <strong>{{projectName}}</strong> has been stagnant for over 3 days.</p>',
    bodyText: 'Task "{{taskTitle}}" in project "{{projectName}}" has been stagnant for over 3 days.',
    inAppMessage: "Task '{{taskTitle}}' has been stagnant for over 3 days.",
    variables: ['taskTitle', 'projectName', 'actionUrl'] },

  { slug: 'task_comment_added', name: 'Task Comment Added', description: 'When a new comment is posted on a task', category: 'task',
    subject: 'New comment on: {{taskTitle}} [{{projectName}}]',
    bodyHtml: '<p><strong>{{authorName}}</strong> commented on task <strong>{{taskTitle}}</strong>:</p><blockquote>{{commentPreview}}</blockquote>',
    bodyText: '{{authorName}} commented on task "{{taskTitle}}": {{commentPreview}}',
    inAppMessage: '{{authorName}} commented on "{{taskTitle}}"',
    variables: ['taskTitle', 'projectName', 'authorName', 'commentPreview', 'actionUrl'] },

  { slug: 'task_deliverable_uploaded', name: 'Deliverable Uploaded', description: 'When a new deliverable version is uploaded', category: 'task',
    subject: 'New deliverable for: {{taskTitle}} [{{projectName}}]',
    bodyHtml: '<p>A new deliverable (v{{version}}) has been uploaded for task <strong>{{taskTitle}}</strong> by {{uploadedBy}}.</p>',
    bodyText: 'A new deliverable (v{{version}}) has been uploaded for task "{{taskTitle}}" by {{uploadedBy}}.',
    inAppMessage: 'Deliverable v{{version}} uploaded for "{{taskTitle}}"',
    variables: ['taskTitle', 'projectName', 'version', 'uploadedBy', 'actionUrl'] },

  // ── Mention Category ──
  { slug: 'user_mentioned_in_task', name: 'Mentioned in Task', description: 'When a user is @mentioned in a task comment', category: 'task',
    subject: '{{authorName}} mentioned you in: {{taskTitle}} [{{projectName}}]',
    bodyHtml: '<p><strong>{{authorName}}</strong> mentioned you in a comment on task <strong>{{taskTitle}}</strong> ({{projectName}}):</p><blockquote style="border-left:3px solid #6366f1;padding:8px 12px;margin:12px 0;background:#f8fafc;border-radius:4px;">{{commentPreview}}</blockquote>',
    bodyText: '{{authorName}} mentioned you in a comment on task "{{taskTitle}}" ({{projectName}}): {{commentPreview}}',
    inAppMessage: '{{authorName}} mentioned you in "{{taskTitle}}"',
    variables: ['taskTitle', 'projectName', 'authorName', 'commentPreview', 'actionUrl'] },

  { slug: 'user_mentioned_in_issue', name: 'Mentioned in Issue', description: 'When a user is @mentioned in an issue comment', category: 'issue',
    subject: '{{authorName}} mentioned you in issue: {{issueTitle}}',
    bodyHtml: '<p><strong>{{authorName}}</strong> mentioned you in a comment on issue <strong>{{issueTitle}}</strong>:</p><blockquote style="border-left:3px solid #6366f1;padding:8px 12px;margin:12px 0;background:#f8fafc;border-radius:4px;">{{commentPreview}}</blockquote>',
    bodyText: '{{authorName}} mentioned you in a comment on issue "{{issueTitle}}": {{commentPreview}}',
    inAppMessage: '{{authorName}} mentioned you in issue "{{issueTitle}}"',
    variables: ['issueTitle', 'authorName', 'commentPreview', 'actionUrl'] },

  // ── Client Input Category ──
  { slug: 'client_input_requested', name: 'Client Input Requested', description: 'When PM requests client input on a task', category: 'client_input',
    subject: 'Your input is needed: {{taskTitle}} [{{projectName}}]',
    bodyHtml: '<p>Your PM has requested your input on task <strong>{{taskTitle}}</strong>:</p><blockquote>{{requestNote}}</blockquote>',
    bodyText: 'Your PM has requested your input on task "{{taskTitle}}": {{requestNote}}',
    inAppMessage: 'Your PM has requested your input: "{{requestNote}}"',
    variables: ['taskTitle', 'projectName', 'requestNote', 'actionUrl'] },

  { slug: 'client_input_fulfilled', name: 'Client Input Fulfilled', description: 'When client provides requested input', category: 'client_input',
    subject: 'Client responded on: {{taskTitle}} [{{projectName}}]',
    bodyHtml: '<p>Client has provided input on task <strong>{{taskTitle}}</strong> in project <strong>{{projectName}}</strong>.</p>',
    bodyText: 'Client has provided input on task "{{taskTitle}}" in project "{{projectName}}".',
    inAppMessage: 'Client has provided input on task: {{taskTitle}}',
    variables: ['taskTitle', 'projectName', 'actionUrl'] },

  // ── Project Category ──
  { slug: 'project_created', name: 'Project Created', description: 'When a new project is created', category: 'project',
    subject: 'New Project: {{projectName}} for {{clientName}}',
    bodyHtml: '<p>A new project <strong>{{projectName}}</strong> has been created for <strong>{{clientName}}</strong>.</p>',
    bodyText: 'A new project "{{projectName}}" has been created for "{{clientName}}".',
    inAppMessage: 'New project created: {{projectName}}',
    variables: ['projectName', 'clientName', 'assignedBy', 'actionUrl'] },

  // ── Pipeline / Content Review Category ──
  { slug: 'content_submitted_for_review', name: 'Content Submitted for Review', description: 'When content is submitted to PM for review', category: 'pipeline',
    subject: '[Review] "{{postTitle}}" submitted for review \u2014 {{projectName}}',
    bodyHtml: '<p>Content <strong>\u201c{{postTitle}}\u201d</strong> ({{postType}}) in project <strong>{{projectName}}</strong> has been submitted for your review{{roundLabel}}.</p><p>Submitted by: {{submittedBy}} on {{submittedAt}}</p>',
    bodyText: 'Content "{{postTitle}}" ({{postType}}) in project "{{projectName}}" has been submitted for review{{roundLabel}}. Submitted by {{submittedBy}} on {{submittedAt}}.',
    inAppMessage: '[{{projectName}}] "{{postTitle}}" ({{postType}}) submitted for review{{roundLabel}}',
    variables: ['postTitle', 'projectName', 'postType', 'submittedBy', 'submittedAt', 'roundLabel', 'actionUrl'] },

  { slug: 'content_pm_approved', name: 'Content PM Approved', description: 'When PM approves content', category: 'pipeline',
    subject: '[Approved] "{{postTitle}}" approved by PM \u2014 {{projectName}}',
    bodyHtml: '<p>Content <strong>\u201c{{postTitle}}\u201d</strong> ({{postType}}) in project <strong>{{projectName}}</strong> has been approved by your PM.</p>',
    bodyText: 'Content "{{postTitle}}" ({{postType}}) in project "{{projectName}}" has been approved by your PM.',
    inAppMessage: '[{{projectName}}] "{{postTitle}}" ({{postType}}) approved by PM',
    variables: ['postTitle', 'projectName', 'postType', 'actionUrl'] },

  { slug: 'content_pm_changes_requested', name: 'Content PM Changes Requested', description: 'When PM requests changes', category: 'pipeline',
    subject: '[Changes Requested] "{{postTitle}}" \u2014 {{projectName}}',
    bodyHtml: '<p>Your PM has requested changes on <strong>\u201c{{postTitle}}\u201d</strong> ({{postType}}) in project <strong>{{projectName}}</strong>.</p>',
    bodyText: 'Your PM has requested changes on "{{postTitle}}" ({{postType}}) in project "{{projectName}}".',
    inAppMessage: '[{{projectName}}] PM requested changes on "{{postTitle}}" ({{postType}})',
    variables: ['postTitle', 'projectName', 'postType', 'actionUrl'] },

  { slug: 'content_client_approved', name: 'Content Client Approved', description: 'When client approves content', category: 'pipeline',
    subject: '[Client Approved] "{{postTitle}}" \u2014 {{projectName}}',
    bodyHtml: '<p>Great news! The client has approved <strong>\u201c{{postTitle}}\u201d</strong> ({{postType}}) in project <strong>{{projectName}}</strong>.</p>',
    bodyText: 'The client has approved "{{postTitle}}" ({{postType}}) in project "{{projectName}}".',
    inAppMessage: '[{{projectName}}] "{{postTitle}}" ({{postType}}) approved by client',
    variables: ['postTitle', 'projectName', 'postType', 'actionUrl'] },

  { slug: 'content_client_changes_requested', name: 'Content Client Changes Requested', description: 'When client requests changes', category: 'pipeline',
    subject: '[Client Changes] "{{postTitle}}" \u2014 {{projectName}}',
    bodyHtml: '<p>Client requested changes on <strong>\u201c{{postTitle}}\u201d</strong> ({{postType}}) in project <strong>{{projectName}}</strong>.</p>',
    bodyText: 'Client requested changes on "{{postTitle}}" ({{postType}}) in project "{{projectName}}".',
    inAppMessage: '[{{projectName}}] Client requested changes on "{{postTitle}}" ({{postType}})',
    variables: ['postTitle', 'projectName', 'postType', 'actionUrl'] },

  { slug: 'content_ready_for_client_review', name: 'Content Ready for Client Review', description: 'When PM approves content and it is sent to client for review', category: 'pipeline',
    subject: '[Review Needed] "{{postTitle}}" is ready for your review \u2014 {{projectName}}',
    bodyHtml: '<p>Content <strong>\u201c{{postTitle}}\u201d</strong> ({{postType}}) in project <strong>{{projectName}}</strong> has been approved by the PM and is now ready for your review.</p>',
    bodyText: 'Content "{{postTitle}}" ({{postType}}) in project "{{projectName}}" is ready for your review.',
    inAppMessage: '[{{projectName}}] "{{postTitle}}" ({{postType}}) is ready for your review',
    variables: ['postTitle', 'projectName', 'postType', 'actionUrl'] },

  { slug: 'content_published', name: 'Content Published', description: 'When content is published', category: 'pipeline',
    subject: '[Published] "{{postTitle}}" \u2014 {{projectName}}',
    bodyHtml: '<p>Content <strong>\u201c{{postTitle}}\u201d</strong> ({{postType}}) in project <strong>{{projectName}}</strong> has been published.</p>',
    bodyText: 'Content "{{postTitle}}" ({{postType}}) in project "{{projectName}}" has been published.',
    inAppMessage: '[{{projectName}}] "{{postTitle}}" ({{postType}}) has been published',
    variables: ['postTitle', 'projectName', 'postType', 'actionUrl'] },

  // ── Issue Category ──
  { slug: 'issue_created', name: 'Issue Created', description: 'When a new support issue is reported', category: 'issue',
    subject: 'New Issue: {{issueTitle}}',
    bodyHtml: '<p>A new issue has been reported: <strong>{{issueTitle}}</strong></p><p>Client: {{clientName}}</p>',
    bodyText: 'A new issue has been reported: "{{issueTitle}}" — Client: {{clientName}}.',
    inAppMessage: 'New issue reported: {{issueTitle}}',
    variables: ['issueTitle', 'clientName', 'reportedBy', 'actionUrl'] },

  { slug: 'issue_assigned', name: 'Issue Assigned', description: 'When an issue is assigned to a user', category: 'issue',
    subject: 'Issue assigned to you: {{issueTitle}}',
    bodyHtml: '<p>Issue <strong>{{issueTitle}}</strong> has been assigned to you.</p>',
    bodyText: 'Issue "{{issueTitle}}" has been assigned to you.',
    inAppMessage: 'Issue assigned to you: {{issueTitle}}',
    variables: ['issueTitle', 'clientName', 'assignedBy', 'actionUrl'] },

  { slug: 'issue_status_changed', name: 'Issue Status Changed', description: 'When an issue status is updated', category: 'issue',
    subject: 'Issue "{{issueTitle}}" \u2192 {{newStatus}}',
    bodyHtml: '<p>Issue <strong>{{issueTitle}}</strong> status changed to <strong>{{newStatus}}</strong>.</p>',
    bodyText: 'Issue "{{issueTitle}}" status changed to {{newStatus}}.',
    inAppMessage: 'Issue "{{issueTitle}}" \u2192 {{newStatus}}',
    variables: ['issueTitle', 'oldStatus', 'newStatus', 'changedBy', 'actionUrl'] },

  { slug: 'issue_comment_added', name: 'Issue Comment Added', description: 'When a new comment is posted on an issue', category: 'issue',
    subject: 'New comment on issue: {{issueTitle}}',
    bodyHtml: '<p><strong>{{authorName}}</strong> commented on issue <strong>{{issueTitle}}</strong>.</p>',
    bodyText: '{{authorName}} commented on issue "{{issueTitle}}".',
    inAppMessage: '{{authorName}} commented on issue "{{issueTitle}}"',
    variables: ['issueTitle', 'authorName', 'commentPreview', 'actionUrl'] },

  { slug: 'issue_resolved', name: 'Issue Resolved', description: 'When an issue is resolved', category: 'issue',
    subject: 'Issue Resolved: {{issueTitle}}',
    bodyHtml: '<p>Issue <strong>{{issueTitle}}</strong> has been resolved.</p>',
    bodyText: 'Issue "{{issueTitle}}" has been resolved.',
    inAppMessage: 'Issue resolved: {{issueTitle}}',
    variables: ['issueTitle', 'changedBy', 'actionUrl'] },

  // ── Client / Account Category ──
  { slug: 'client_onboarding_complete', name: 'Client Onboarding Complete', description: 'When a client finishes onboarding', category: 'client',
    subject: 'Onboarding Complete: {{clientName}}',
    bodyHtml: '<p>Client <strong>{{clientName}}</strong> has completed their onboarding.</p>',
    bodyText: 'Client "{{clientName}}" has completed their onboarding.',
    inAppMessage: '{{clientName}} completed onboarding',
    variables: ['clientName', 'actionUrl'] },

  { slug: 'client_health_critical', name: 'Client Health Critical', description: 'When client health score drops below 40', category: 'client',
    subject: 'Health Alert: {{clientName}} (Score: {{healthScore}})',
    bodyHtml: '<p>Client <strong>{{clientName}}</strong> health score has dropped to <strong>{{healthScore}}</strong>.</p>',
    bodyText: 'Client "{{clientName}}" health score has dropped to {{healthScore}}.',
    inAppMessage: '{{clientName}} health score critical: {{healthScore}}',
    variables: ['clientName', 'healthScore', 'actionUrl'] },

  { slug: 'welcome_email', name: 'Welcome Email', description: 'Sent when a new client account is created', category: 'client',
    subject: 'Welcome to Localwaves, {{contactName}}!',
    bodyHtml: '<p>Hi <strong>{{contactName}}</strong>,</p><p>Your Localwaves portal account has been created for <strong>{{clientName}}</strong>.</p><p>Login at: <a href="{{loginUrl}}">{{loginUrl}}</a></p><p>Your temporary password: <code>{{tempPassword}}</code></p><p>Please change your password after first login.</p>',
    bodyText: 'Hi {{contactName}}, Your Localwaves portal account has been created for {{clientName}}. Login at: {{loginUrl}} — Temporary password: {{tempPassword}}',
    inAppMessage: 'Welcome to Localwaves!',
    variables: ['contactName', 'clientName', 'loginUrl', 'tempPassword'] },

  { slug: 'password_reset', name: 'Password Reset', description: 'When an admin resets a client password', category: 'client',
    subject: 'Your Localwaves password has been reset',
    bodyHtml: '<p>Hi {{userName}},</p><p>Your password has been reset by an administrator.</p><p>Your new temporary password: <code>{{tempPassword}}</code></p><p>Please change your password after login.</p>',
    bodyText: 'Hi {{userName}}, Your password has been reset. Temporary password: {{tempPassword}}',
    inAppMessage: 'Your password has been reset',
    variables: ['userName', 'tempPassword'] },

  // ── Meeting Category ──
  { slug: 'meeting_scheduled', name: 'Meeting Scheduled', description: 'When a new meeting is created', category: 'meeting',
    subject: 'Meeting Scheduled: {{meetingTitle}}',
    bodyHtml: '<p>A meeting has been scheduled: <strong>{{meetingTitle}}</strong></p><p>Date: {{scheduledAt}}</p><p><a href="{{meetingLink}}">Join Meeting</a></p>',
    bodyText: 'A meeting has been scheduled: "{{meetingTitle}}" on {{scheduledAt}}.',
    inAppMessage: 'Meeting scheduled: {{meetingTitle}} on {{scheduledAt}}',
    variables: ['meetingTitle', 'scheduledAt', 'meetingLink', 'actionUrl'] },

  // ── Report Category ──
  { slug: 'report_published', name: 'Report Published', description: 'When a monthly report is published to client', category: 'report',
    subject: 'Your Monthly Report is Ready: {{clientName}}',
    bodyHtml: '<p>Your monthly report (<strong>{{reportTitle}}</strong>) for <strong>{{clientName}}</strong> is now available.</p>',
    bodyText: 'Your monthly report "{{reportTitle}}" for "{{clientName}}" is now available.',
    inAppMessage: 'Monthly report published: {{reportTitle}}',
    variables: ['reportTitle', 'clientName', 'actionUrl'] },

  // ── Standup Category ──
  { slug: 'standup_submitted', name: 'Standup Submitted', description: 'When a team member submits a daily standup', category: 'standup',
    subject: 'Standup submitted by {{memberName}}',
    bodyHtml: '<p><strong>{{memberName}}</strong> has submitted their daily standup.</p>',
    bodyText: '{{memberName}} has submitted their daily standup.',
    inAppMessage: '{{memberName}} submitted their daily standup',
    variables: ['memberName', 'actionUrl'] },

  // ── Keyword Category ──
  { slug: 'keyword_suggestion_approved', name: 'Keyword Suggestion Approved', description: 'When PM approves a client keyword suggestion', category: 'keyword',
    subject: 'Your keyword suggestion "{{keyword}}" was approved',
    bodyHtml: '<p>Great news! Your keyword suggestion <strong>\u201c{{keyword}}\u201d</strong> has been approved.</p>',
    bodyText: 'Your keyword suggestion "{{keyword}}" was approved.',
    inAppMessage: 'Keyword approved: "{{keyword}}"',
    variables: ['keyword', 'actionUrl'] },

  { slug: 'keyword_suggestion_rejected', name: 'Keyword Suggestion Rejected', description: 'When PM rejects a client keyword suggestion', category: 'keyword',
    subject: 'Keyword suggestion "{{keyword}}" was not approved',
    bodyHtml: '<p>Your keyword suggestion <strong>\u201c{{keyword}}\u201d</strong> was not approved at this time.</p>',
    bodyText: 'Your keyword suggestion "{{keyword}}" was not approved at this time.',
    inAppMessage: 'Keyword not approved: "{{keyword}}"',
    variables: ['keyword', 'actionUrl'] },

  { slug: 'keyword_approved_by_client', name: 'Keywords Approved by Client', description: 'When client approves proposed keywords', category: 'keyword',
    subject: 'Client approved {{count}} keywords for {{projectName}}',
    bodyHtml: '<p>The client has approved <strong>{{count}}</strong> keyword(s) for project <strong>{{projectName}}</strong>.</p>',
    bodyText: 'The client has approved {{count}} keyword(s) for project "{{projectName}}".',
    inAppMessage: 'Client approved {{count}} keywords for {{projectName}}',
    variables: ['count', 'projectName', 'actionUrl'] },

  { slug: 'keyword_rejected_by_client', name: 'Keywords Rejected by Client', description: 'When client rejects proposed keywords', category: 'keyword',
    subject: 'Client rejected {{count}} keywords for {{projectName}}',
    bodyHtml: '<p>The client has rejected <strong>{{count}}</strong> keyword(s) for project <strong>{{projectName}}</strong>.</p>',
    bodyText: 'The client has rejected {{count}} keyword(s) for project "{{projectName}}".',
    inAppMessage: 'Client rejected {{count}} keywords for {{projectName}}',
    variables: ['count', 'projectName', 'actionUrl'] },

  { slug: 'keyword_edit_suggested', name: 'Keyword Edit Suggested', description: 'When client suggests edits to keywords', category: 'keyword',
    subject: 'Client suggested edits for keywords in {{projectName}}',
    bodyHtml: '<p>The client has suggested edits for <strong>{{count}}</strong> keyword(s) in project <strong>{{projectName}}</strong>.</p>',
    bodyText: 'The client has suggested edits for {{count}} keyword(s) in project "{{projectName}}".',
    inAppMessage: 'Client suggested keyword edits for {{projectName}}',
    variables: ['count', 'projectName', 'actionUrl'] },

  // ── Client Input Category (additional) ──
  { slug: 'client_asset_uploaded', name: 'Client Asset Uploaded', description: 'When client uploads an asset', category: 'client_input',
    subject: 'New asset uploaded: {{filename}}',
    bodyHtml: '<p>A client has uploaded a new asset: <strong>{{filename}}</strong>.</p>',
    bodyText: 'A client has uploaded a new asset: "{{filename}}".',
    inAppMessage: 'Client uploaded asset: {{filename}}',
    variables: ['filename', 'clientName', 'actionUrl'] },

  { slug: 'client_keyword_submitted', name: 'Client Keyword Submitted', description: 'When client submits a keyword suggestion', category: 'client_input',
    subject: 'New keyword suggestion: "{{keyword}}"',
    bodyHtml: '<p>A client has submitted a new keyword suggestion: <strong>\u201c{{keyword}}\u201d</strong>.</p>',
    bodyText: 'A client has submitted a new keyword suggestion: "{{keyword}}".',
    inAppMessage: 'Client submitted keyword: "{{keyword}}"',
    variables: ['keyword', 'clientName', 'actionUrl'] },

  { slug: 'client_business_update', name: 'Client Business Update', description: 'When client submits a business update', category: 'client_input',
    subject: 'New business update from {{clientName}}',
    bodyHtml: '<p><strong>{{clientName}}</strong> has submitted a business update ({{updateType}}).</p>',
    bodyText: '{{clientName}} has submitted a business update ({{updateType}}).',
    inAppMessage: 'Client submitted business update: {{updateType}}',
    variables: ['clientName', 'updateType', 'actionUrl'] },

  // ── Client Category (additional) ──
  { slug: 'client_intake_updated', name: 'Client Intake Updated', description: 'When client updates onboarding intake data', category: 'client',
    subject: 'Client intake data updated for {{projectName}}',
    bodyHtml: '<p>A client has updated their onboarding intake data for project <strong>{{projectName}}</strong>.</p>',
    bodyText: 'A client has updated their onboarding intake data for project "{{projectName}}".',
    inAppMessage: 'Client updated intake data for {{projectName}}',
    variables: ['projectName', 'clientName', 'actionUrl'] },

  // ── Multi-User Client Team Notifications ──
  { slug: 'client_input_fulfilled_team', name: 'Team: Input Fulfilled', description: 'Notifies other client users when a teammate provides requested input', category: 'client_input',
    subject: '{{responderName}} provided input on: {{taskTitle}}',
    bodyHtml: '<p><strong>{{responderName}}</strong> has provided the requested information for task <strong>{{taskTitle}}</strong> in project <strong>{{projectName}}</strong>.</p>',
    bodyText: '{{responderName}} provided input on task "{{taskTitle}}" in project "{{projectName}}".',
    inAppMessage: '{{responderName}} provided input on "{{taskTitle}}"',
    variables: ['responderName', 'taskTitle', 'projectName', 'actionUrl'] },

  { slug: 'client_asset_uploaded_team', name: 'Team: Asset Uploaded', description: 'Notifies other client users when a teammate uploads an asset', category: 'client_input',
    subject: '{{uploaderName}} uploaded: {{filename}}',
    bodyHtml: '<p><strong>{{uploaderName}}</strong> uploaded a new asset: <strong>{{filename}}</strong>.</p>',
    bodyText: '{{uploaderName}} uploaded a new asset: "{{filename}}".',
    inAppMessage: '{{uploaderName}} uploaded asset: {{filename}}',
    variables: ['uploaderName', 'filename', 'clientName', 'actionUrl'] },

  { slug: 'client_keyword_submitted_team', name: 'Team: Keyword Submitted', description: 'Notifies other client users when a teammate suggests a keyword', category: 'client_input',
    subject: '{{submitterName}} suggested keyword: "{{keyword}}"',
    bodyHtml: '<p><strong>{{submitterName}}</strong> suggested a new keyword: <strong>\u201c{{keyword}}\u201d</strong>.</p>',
    bodyText: '{{submitterName}} suggested keyword: "{{keyword}}".',
    inAppMessage: '{{submitterName}} suggested keyword: "{{keyword}}"',
    variables: ['submitterName', 'keyword', 'clientName', 'actionUrl'] },

  { slug: 'client_update_posted_team', name: 'Team: Business Update Posted', description: 'Notifies other client users when a teammate posts a business update', category: 'client_input',
    subject: '{{posterName}} posted a business update',
    bodyHtml: '<p><strong>{{posterName}}</strong> posted a business update ({{updateType}}).</p>',
    bodyText: '{{posterName}} posted a business update ({{updateType}}).',
    inAppMessage: '{{posterName}} posted a business update: {{updateType}}',
    variables: ['posterName', 'updateType', 'clientName', 'actionUrl'] },

  { slug: 'client_issue_created_team', name: 'Team: Issue Created', description: 'Notifies other client users when a teammate reports an issue', category: 'client_input',
    subject: '{{reporterName}} reported an issue: {{issueTitle}}',
    bodyHtml: '<p><strong>{{reporterName}}</strong> reported a new issue: <strong>{{issueTitle}}</strong>.</p>',
    bodyText: '{{reporterName}} reported an issue: "{{issueTitle}}".',
    inAppMessage: '{{reporterName}} reported issue: "{{issueTitle}}"',
    variables: ['reporterName', 'issueTitle', 'clientName', 'actionUrl'] },

  { slug: 'client_user_added', name: 'Team: User Added', description: 'Notifies existing client users when a new member is added', category: 'client',
    subject: '{{addedName}} has joined {{clientName}}',
    bodyHtml: '<p><strong>{{addedName}}</strong> has been added to the <strong>{{clientName}}</strong> portal account.</p>',
    bodyText: '{{addedName}} has been added to the {{clientName}} portal account.',
    inAppMessage: '{{addedName}} has joined {{clientName}}',
    variables: ['addedName', 'clientName', 'actionUrl'] },

  { slug: 'client_user_removed', name: 'Team: User Removed', description: 'Notifies remaining client users when a member is removed', category: 'client',
    subject: '{{removedName}} has been removed from {{clientName}}',
    bodyHtml: '<p><strong>{{removedName}}</strong> has been removed from the <strong>{{clientName}}</strong> portal account.</p>',
    bodyText: '{{removedName}} has been removed from the {{clientName}} portal account.',
    inAppMessage: '{{removedName}} has been removed from {{clientName}}',
    variables: ['removedName', 'clientName', 'actionUrl'] },
];

async function seedNotificationTemplates() {
  console.log('Seeding notification templates...');
  let created = 0;
  let updated = 0;

  for (const t of templates) {
    const existing = await prisma.notificationTemplate.findUnique({ where: { slug: t.slug } });
    if (existing) {
      await prisma.notificationTemplate.update({
        where: { slug: t.slug },
        data: {
          name: t.name,
          description: t.description,
          category: t.category,
          variables: t.variables,
          subject: t.subject,
          bodyHtml: t.bodyHtml,
          bodyText: t.bodyText || null,
          inAppMessage: t.inAppMessage,
        },
      });
      updated++;
    } else {
      await prisma.notificationTemplate.create({ data: t });
      created++;
    }
  }

  console.log(`Done: ${created} created, ${updated} updated (${templates.length} total)`);
}

seedNotificationTemplates()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
