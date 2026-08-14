# SQL GROUP BY 报错排查：非聚合列未出现在 GROUP BY 中

## 1. 报错现象

执行如下 SQL 时：

```sql
SELECT department, employee_name, COUNT(*) AS cnt
FROM employees
GROUP BY department;
```

数据库报错：

- **MySQL（5.7+ / 8.x）**：`Expression #2 of SELECT list is not in GROUP BY clause and contains nonaggregated column 'employees.employee_name' which is not functionally dependent on columns in GROUP BY clause; this is incompatible with sql_mode=only_full_group_by`
- **PostgreSQL**：`column "employees.employee_name" must appear in the GROUP BY clause or be used in an aggregate function`
- **SQL Server**：`Column 'employees.employee_name' is invalid in the select list because it is not contained in either an aggregate function or the GROUP BY clause`

## 2. 根本原因（SQL 标准）

SQL 标准规定：`GROUP BY` 分组后，每一组代表多行数据的聚合结果，因此 **SELECT 列表中的每一列必须满足二者之一**：

1. **出现在 GROUP BY 子句中**（分组键——组内所有行该值相同，结果唯一）；
2. **被聚合函数包裹**（如 `COUNT` / `SUM` / `AVG` / `MAX` / `MIN`）。

`employee_name` 既不在 GROUP BY 里、也没被聚合函数包裹 → 每组里这个名字有多个取值，数据库无法确定该输出哪一行，因此拒绝执行。这是 SQL 的确定性保证，不是数据库"太严格"。

## 3. 错误 SQL 示例

```sql
-- 需求：统计每个部门的员工人数，并且要展示员工姓名
SELECT department, employee_name, COUNT(*) AS cnt
FROM employees
GROUP BY department;
-- ❌ 报错：employee_name 既不在 GROUP BY 也没有被聚合
```

## 4. 修正方案（按真实需求选择）

### 方案 A：需求只是「每个部门的员工数」→ 去掉多余列

```sql
SELECT department, COUNT(*) AS cnt
FROM employees
GROUP BY department;
-- ✅ department 在 GROUP BY 中；COUNT(*) 是聚合函数
```

### 方案 B：需求是「部门 + 每个部门某列的具体值（如薪资最高的员工）」→ 用聚合

```sql
SELECT department, MAX(salary) AS max_salary, COUNT(*) AS cnt
FROM employees
GROUP BY department;
-- ✅ MAX(salary) 是聚合函数，合法
```

### 方案 C：需求是「部门 + 部门内员工姓名清单」→ 用 GROUP_CONCAT / STRING_AGG

```sql
-- MySQL
SELECT department,
       GROUP_CONCAT(employee_name ORDER BY employee_name) AS names,
       COUNT(*) AS cnt
FROM employees
GROUP BY department;

-- PostgreSQL
SELECT department,
       STRING_AGG(employee_name, ', ' ORDER BY employee_name) AS names,
       COUNT(*) AS cnt
FROM employees
GROUP BY department;
```

### 方案 D：需求是「部门 + 具体到每个员工」→ 根本不该分组，改用窗口函数

```sql
-- 每行保留员工明细，同时附带部门人数
SELECT department, employee_name,
       COUNT(*) OVER (PARTITION BY department) AS dept_cnt
FROM employees;
-- ✅ 窗口函数不压缩行数，明细和聚合可兼得
```

### 方案 E：确实要「每组随机/特定一行」→ 用窗口函数取第一行（各库语法略异）

```sql
-- PostgreSQL：每组薪资最高的员工
SELECT department, employee_name, salary
FROM (
  SELECT department, employee_name, salary,
         ROW_NUMBER() OVER (PARTITION BY department ORDER BY salary DESC) AS rn
  FROM employees
) t
WHERE rn = 1;
```

## 5. 同类避坑场景（3 个）

### 坑 1：HAVING 里用未聚合列

```sql
-- ❌ 错误：HAVING 中 salary 未聚合
SELECT department, AVG(salary) FROM employees GROUP BY department HAVING salary > 5000;
-- ✅ 正确：HAVING 只放聚合条件（组级过滤）；行级过滤用 WHERE
SELECT department, AVG(salary) FROM employees GROUP BY department HAVING AVG(salary) > 5000;
```

### 坑 2：MySQL 低版本能跑、高版本报错（sql_mode 差异）

```sql
-- 同一句 SQL：MySQL 5.6（sql_mode 不含 ONLY_FULL_GROUP_BY）可执行，
-- 5.7+ 默认开启 ONLY_FULL_GROUP_BY 后报错。
-- ✅ 排查：SHOW VARIABLES LIKE 'sql_mode'; 建议按标准写法修正而非临时关闭该模式。
SELECT department, employee_name FROM employees GROUP BY department;
```

### 坑 3：GROUP BY 顺序与 SELECT 不一致（部分方言）

```sql
-- PostgreSQL 允许 GROUP BY 列别名/序号，但 SELECT 顺序混乱时易踩歧义
SELECT employee_name, department, COUNT(*)
FROM employees
GROUP BY department, employee_name;  -- ✅ 键列齐全即可，顺序无要求
```

## 6. 快速自查清单

| 检查项 | 说明 |
|---|---|
| SELECT 每列都在 GROUP BY 中？ | 不在 → 必须被聚合函数包裹 |
| HAVING 只放聚合条件？ | 组级过滤用 HAVING，行级用 WHERE |
| 需要明细+统计？ | 用窗口函数 `OVER (PARTITION BY ...)` |
| 需要每组一行代表？ | 用 `ROW_NUMBER() + 子查询` 取第一行 |
| MySQL 老库突然报错？ | 检查 `sql_mode` 是否含 `ONLY_FULL_GROUP_BY` |

---

*本文档由 uumit-ops 出品 · SQL 查询排错与优化说明 · 2026-08-12*
