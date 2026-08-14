package adminassistant

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting"
	assistantsetting "github.com/QuantumNous/new-api/setting/adminassistant"
	"github.com/QuantumNous/new-api/setting/ratio_setting"
)

type Status struct {
	Config          assistantsetting.Config `json:"config"`
	Secrets         map[string]bool         `json:"secrets"`
	ResolvedModel   string                  `json:"resolved_model"`
	ModelAvailable  bool                    `json:"model_available"`
	ChannelCount    int64                   `json:"channel_count"`
	EnabledModels   int                     `json:"enabled_models"`
	GroupCount      int                     `json:"group_count"`
	TemporaryModels []string                `json:"temporary_models,omitempty"`
	AutomaticTask   AutomaticTaskStatus     `json:"automatic_task"`
}

type CommandReport struct {
	GeneratedAt time.Time `json:"generated_at"`
	Command     string    `json:"command"`
	Model       string    `json:"model"`
	LocalPlan   string    `json:"local_plan"`
	AIOutput    string    `json:"ai_output,omitempty"`
	AIError     string    `json:"ai_error,omitempty"`
}

type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func BuildStatus() Status {
	cfg := assistantsetting.Snapshot()
	resolvedModel := resolveConfiguredModel(cfg.Model)
	var channelCount int64
	_ = model.DB.Model(&model.Channel{}).Count(&channelCount).Error
	return Status{
		Config:         cfg,
		Secrets:        assistantsetting.SecretStatus(),
		ResolvedModel:  resolvedModel,
		ModelAvailable: resolvedModel != "" && resolvedModel == strings.TrimSpace(cfg.Model),
		ChannelCount:   channelCount,
		EnabledModels:  len(model.GetEnabledModels()),
		GroupCount:     len(ratio_setting.GetGroupRatioCopy()),
		AutomaticTask:  GetAutomaticTaskStatus(),
	}
}

func BuildCommandReport(ctx context.Context, baseURL string, command string, managementContext string) CommandReport {
	return BuildCommandReportWithHistory(ctx, baseURL, command, managementContext, nil)
}

func BuildCommandReportWithHistory(ctx context.Context, baseURL string, command string, managementContext string, history []ChatMessage) CommandReport {
	cfg := assistantsetting.Snapshot()
	configuredModel := strings.TrimSpace(cfg.Model)
	resolvedModel := resolveConfiguredModel(configuredModel)
	command = strings.TrimSpace(command)
	report := CommandReport{
		GeneratedAt: time.Now(),
		Command:     command,
		Model:       configuredModel,
		LocalPlan:   localPlan(command),
	}
	if configuredModel == "" {
		report.AIError = "未选择 AI 管理助手模型"
		return report
	}
	if resolvedModel == "" {
		report.AIError = "已选择的 AI 管理助手模型当前不可用；为避免把管理上下文发送给未授权模型，已停止自动回退"
		return report
	}
	cfg.Model = resolvedModel
	report.Model = resolvedModel
	output, err := callConfiguredModel(ctx, baseURL, cfg, buildPrompt(command, report.LocalPlan, managementContext), history)
	if err != nil {
		report.AIError = err.Error()
	} else {
		report.AIOutput = output
	}
	return report
}

func resolveConfiguredModel(configured string) string {
	configured = strings.TrimSpace(configured)
	enabled := model.GetEnabledModels()
	enabledSet := make(map[string]struct{}, len(enabled))
	for _, name := range enabled {
		name = strings.TrimSpace(name)
		if name != "" {
			enabledSet[name] = struct{}{}
		}
	}
	if _, ok := enabledSet[configured]; ok {
		return configured
	}
	for _, target := range setting.GetModelAliasTargets(configured) {
		if _, ok := enabledSet[target]; ok {
			return configured
		}
	}
	if composite, ok := setting.GetCompositeModel(configured); ok {
		for _, target := range composite.Targets {
			if _, enabled := enabledSet[target.Model]; enabled {
				return configured
			}
		}
	}
	return ""
}

func localPlan(command string) string {
	lower := strings.ToLower(command)
	steps := []string{"读取当前后台概况", "判断涉及的设置项或渠道", "生成可审计的变更建议"}
	if strings.Contains(lower, "临时") || strings.Contains(lower, "api") || strings.Contains(lower, "key") {
		steps = append(steps, "如包含 base url、key、模型和限制条件，可使用临时渠道快速创建动作")
	}
	if strings.Contains(lower, "注册") || strings.Contains(lower, "分组") || strings.Contains(lower, "合成") || strings.Contains(lower, "模型") {
		steps = append(steps, "检查注册、原版用户/渠道分组和默认权益")
	}
	if strings.Contains(lower, "导入") || strings.Contains(lower, "omni") {
		steps = append(steps, "检查 OmniRoute、临时渠道或兼容接口导入路径，生成可执行配置")
	}
	if strings.Contains(lower, "安全") || strings.Contains(lower, "防御") {
		steps = append(steps, "安全防御属于独立防御模块，助手只能通过受控配置动作协助开启或调整")
	}
	return strings.Join(steps, "；")
}

func buildPrompt(command string, localPlan string, managementContext string) string {
	return "你是 xxsx-api 管理后台的全站 AI 助手，可以帮助管理员管理设置、渠道、原版用户/渠道分组、合成模型、OmniRoute 导入和临时渠道。" +
		"输出必须包含：理解到的目标、建议动作、风险、需要确认的写操作。不要绕过权限、审计或安全限制。" +
		"安全防御与 QQ 远程管理位于本助手内，仍应通过受控后台动作协助配置。" +
		"如需修改配置，请在回答末尾给出一个 JSON 代码块，结构必须是 {\"actions\":[...]}。" +
		"动作可使用 update_options、quick_add_temporary_channel、update_management_config、update_channel、sync_omniroute、sync_sub2api、repair_abilities、create_trial_user、create_redemption；不要把密码、Token、API Key 或私钥放进 update_options。" +
		"当用户只粘贴 API Base 和 API Key 并要求导入时，优先生成 quick_add_temporary_channel；未指定限制时使用 1440 分钟有效期、default 原版分组，并让后端自动读取模型。" +
		"create_trial_user 使用 trial_user={username,group,quota}；create_redemption 使用 redemption={name,quota,count,expires_in_minutes}。" +
		"update_channel 只允许修改 id、name、status、models、groups、model_groups、priority、weight，不能修改 Key 或 Base URL。" +
		"JSON 动作是否执行由脱敏管理上下文里的 apply_requested 决定；为 true 时管理员已经确认执行，不要再次要求重复确认，为 false 时只生成草案。\n用户命令：" + command + "\n本地计划：" + localPlan + "\n脱敏管理上下文：" + managementContext
}

func callConfiguredModel(ctx context.Context, baseURL string, cfg assistantsetting.Config, prompt string, history []ChatMessage) (string, error) {
	if strings.TrimSpace(cfg.Model) == "" {
		return "", fmt.Errorf("未选择 AI 管理助手模型")
	}
	if strings.TrimSpace(cfg.InternalAPIKey) == "" {
		return "", fmt.Errorf("未配置 AI 管理助手内部调用密钥")
	}
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return "", fmt.Errorf("无法确定本地 API 地址")
	}
	messages := []map[string]string{{"role": "system", "content": "你是受控的全站管理助手。只通过后台授权接口提出或执行配置，禁止绕过审计和权限。"}}
	if len(history) > 16 {
		history = history[len(history)-16:]
	}
	for _, item := range history {
		role := strings.TrimSpace(item.Role)
		content := strings.TrimSpace(item.Content)
		if (role != "user" && role != "assistant") || content == "" {
			continue
		}
		runes := []rune(content)
		if len(runes) > 4000 {
			content = string(runes[:4000])
		}
		messages = append(messages, map[string]string{"role": role, "content": content})
	}
	messages = append(messages, map[string]string{"role": "user", "content": prompt})
	payload := map[string]any{
		"model":    cfg.Model,
		"messages": messages,
		"stream":   false,
	}
	data, err := common.Marshal(payload)
	if err != nil {
		return "", err
	}
	requestCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, baseURL+"/v1/chat/completions", bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.InternalAPIKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1200))
		return "", fmt.Errorf("AI 调用失败 HTTP %d: %s", resp.StatusCode, common.MaskSensitiveInfo(strings.TrimSpace(string(body))))
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := common.DecodeJson(resp.Body, &parsed); err != nil {
		return "", err
	}
	if len(parsed.Choices) == 0 {
		return "", fmt.Errorf("AI 响应为空")
	}
	return strings.TrimSpace(parsed.Choices[0].Message.Content), nil
}

// BuildTwinReply 把用户消息转发到本机分身（虚无圣灵）的 /api/cluster/chat，
// 返回分身人格回复。仅走脱敏人格，不包含微信原始数据（隐私铁律）。
func BuildTwinReply(ctx context.Context, endpoint string, token string, message string) (string, error) {
	endpoint = strings.TrimRight(strings.TrimSpace(endpoint), "/")
	if endpoint == "" {
		return "", fmt.Errorf("未配置本机分身端点")
	}
	payload, err := common.Marshal(map[string]string{"message": message})
	if err != nil {
		return "", err
	}
	requestCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint+"/api/cluster/chat", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if strings.TrimSpace(token) != "" {
		req.Header.Set("x-pi-token", strings.TrimSpace(token))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("连接本机分身失败: %s", err.Error())
	}
	defer resp.Body.Close()
	// 读取完整 body：分身回复可能带 attachments 元数据，1200 字节会截断 JSON 导致解析失败
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	switch resp.StatusCode {
	case http.StatusTooManyRequests:
		return "", fmt.Errorf("分身对话请求过于频繁，请稍后再试")
	case http.StatusUnauthorized:
		return "", fmt.Errorf("分身对话鉴权失败")
	case http.StatusServiceUnavailable:
		return "", fmt.Errorf("本机分身未在运行")
	}
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("分身对话失败 HTTP %d: %s", resp.StatusCode, common.MaskSensitiveInfo(strings.TrimSpace(string(body))))
	}
	var parsed struct {
		Ok    bool   `json:"ok"`
		Reply string `json:"reply"`
		Error string `json:"error"`
	}
	if err := common.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("分身回复解析失败: %s", strings.TrimSpace(string(body)))
	}
	if !parsed.Ok || strings.TrimSpace(parsed.Reply) == "" {
		if strings.TrimSpace(parsed.Error) != "" {
			return "", fmt.Errorf("%s", parsed.Error)
		}
		return "", fmt.Errorf("分身无回复")
	}
	return strings.TrimSpace(parsed.Reply), nil
}
