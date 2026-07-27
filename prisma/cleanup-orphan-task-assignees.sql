-- Fix Prisma db push failure:
--   Cannot add or update a child row ... CONSTRAINT `_TaskAssignees_A_fkey`
-- Orphan rows in the Task↔User join table point at deleted tasks (or users).

-- Preview orphans (task side = column A)
SELECT ta.A AS taskId, ta.B AS userId
FROM `_TaskAssignees` ta
LEFT JOIN `task` t ON t.id = ta.A
WHERE t.id IS NULL;

-- Preview orphans (user side = column B)
SELECT ta.A AS taskId, ta.B AS userId
FROM `_TaskAssignees` ta
LEFT JOIN `user` u ON u.id = ta.B
WHERE u.id IS NULL;

-- Delete orphans
DELETE ta
FROM `_TaskAssignees` ta
LEFT JOIN `task` t ON t.id = ta.A
WHERE t.id IS NULL;

DELETE ta
FROM `_TaskAssignees` ta
LEFT JOIN `user` u ON u.id = ta.B
WHERE u.id IS NULL;

-- Also clean parentTaskId pointing at missing parents (helps SubTasks Cascade FK)
UPDATE `task` child
LEFT JOIN `task` parent ON parent.id = child.parentTaskId
SET child.parentTaskId = NULL
WHERE child.parentTaskId IS NOT NULL
  AND parent.id IS NULL;
