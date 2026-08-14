package controller

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	adminassistantsvc "github.com/QuantumNous/new-api/service/adminassistant"
	securitydefensesvc "github.com/QuantumNous/new-api/service/securitydefense"
	assistantsetting "github.com/QuantumNous/new-api/setting/adminassistant"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

var assistantStoredSecretPattern = regexp.MustCompile(`(?i)((?:api[ _-]?key|token|authorization|bearer|secret|password|redemption[ _-]?code|密码|密钥|兑换码)\s*["']?\s*[:=：]?\s*["']?)[^\s"',;}\]]+`)

// twinVirtualConversationID 本机分身（虚无圣灵）虚拟会话 ID 哨兵。
// 它不对应 HK DB 里的真实记录——对话记录走代理读取（APP→HK→本机实时读本机 history），
// 不在 HK 侧复制/同步（对话是活的，读本机为准）。
const twinVirtualConversationID int64 = -1000

// twinVirtualConversation 构造本机分身虚拟会话对象（不入 HK DB）。
func twinVirtualConversation(userId int, messages []model.AdminAssistantMessage) *model.AdminAssistantConversation {
	updated := common.GetTimestamp()
	if len(messages) > 0 && messages[len(messages)-1].CreatedAt > 0 {
		updated = messages[len(messages)-1].CreatedAt
	}
	return &model.AdminAssistantConversation{
		Id:        twinVirtualConversationID,
		UserId:    userId,
		Title:     "虚无圣灵（分身）",
		Kind:      model.AdminAssistantConversationKindTwin,
		CreatedAt: updated,
		UpdatedAt: updated,
	}
}

// fetchTwinHistory 代理读取本机分身（虚无圣灵）的对话历史：
//
//	GET <AssistantTwinEndpoint>/api/chat/twin/history（x-pi-token=AssistantTwinToken）
//	与发送链路（/api/cluster/chat）共用同一 Endpoint/Token 配置。
//
// 仅走脱敏人格（user-twin），不包含微信原始数据（隐私铁律）。失败/无记录返回空切片。
func fetchTwinHistory(ctx context.Context) []model.AdminAssistantMessage {
	twinCfg := assistantsetting.TwinSnapshot()
	if !twinCfg.Enabled || strings.TrimSpace(twinCfg.Endpoint) == "" {
		return nil
	}
	base := strings.TrimRight(strings.TrimSpace(twinCfg.Endpoint), "/")
	reqCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, base+"/api/chat/twin/history", nil)
	if err != nil {
		return nil
	}
	if tok := strings.TrimSpace(twinCfg.Token); tok != "" {
		req.Header.Set("x-pi-token", tok)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	var parsed struct {
		Ok       bool `json:"ok"`
		Messages []struct {
			Ts      string `json:"ts"`
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || !parsed.Ok {
		return nil
	}
	out := make([]model.AdminAssistantMessage, 0, len(parsed.Messages))
	for i, m := range parsed.Messages {
		if m.Role != "user" && m.Role != "assistant" {
			continue
		}
		var ca int64
		if t, err := time.Parse(time.RFC3339, m.Ts); err == nil {
			ca = t.Unix()
		}
		out = append(out, model.AdminAssistantMessage{
			Id:             int64(-(i + 1)), // 本机会话内顺序 id（负值避免与 HK 记录混淆）
			ConversationId: twinVirtualConversationID,
			UserId:         0,
			Role:           m.Role,
			Content:        m.Content,
			CreatedAt:      ca,
		})
	}
	return out
}

func ListAdminAssistantConversations(c *gin.Context) {
	kind := strings.TrimSpace(c.Query("kind"))
	if kind == model.AdminAssistantConversationKindTwin || kind == "primary" {
		// 本机分身：代理读取本机 twin history，合成虚拟会话（不落 HK 表，实时读本机为准）。
		// 始终返回分身会话（本机无记录时为空会话、不显示 HK 测试记录，仍可发首条消息）。
		msgs := fetchTwinHistory(c.Request.Context())
		convs := []model.AdminAssistantConversation{
			*twinVirtualConversation(c.GetInt("id"), msgs),
		}
		common.ApiSuccess(c, convs)
		return
	}
	conversations, err := model.ListAdminAssistantConversations(c.GetInt("id"), kind, 50)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, conversations)
}

func CreateAdminAssistantConversation(c *gin.Context) {
	var req struct {
		Title string `json:"title"`
		Kind  string `json:"kind"`
	}
	if c.Request.ContentLength > 0 {
		if err := common.DecodeJson(c.Request.Body, &req); err != nil {
			common.ApiError(c, err)
			return
		}
	}
	kind := strings.TrimSpace(req.Kind)
	if kind != "" && kind != model.AdminAssistantConversationKindTwin {
		kind = "" // 仅允许 twin 或默认 manual；automatic/qq 为系统会话，不可经此创建
	}
	conversation, err := model.CreateAdminAssistantConversationWithKind(c.GetInt("id"), req.Title, kind)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	recordManageAudit(c, "admin_assistant.conversation.create", map[string]interface{}{"conversation_id": conversation.Id})
	common.ApiSuccess(c, conversation)
}

func DeleteAdminAssistantConversation(c *gin.Context) {
	id, ok := adminAssistantConversationId(c)
	if !ok {
		return
	}
	if err := model.DeleteAdminAssistantConversation(c.GetInt("id"), id); err != nil {
		if errors.Is(err, model.ErrProtectedAdminAssistantConversation) {
			common.ApiErrorMsg(c, "系统会话不能删除")
			return
		}
		if errors.Is(err, gorm.ErrRecordNotFound) {
			common.ApiErrorMsg(c, "对话不存在")
			return
		}
		common.ApiError(c, err)
		return
	}
	recordManageAudit(c, "admin_assistant.conversation.delete", map[string]interface{}{"conversation_id": id})
	common.ApiSuccess(c, gin.H{"deleted": true})
}

func SendAdminAssistantQQMessage(c *gin.Context) {
	id, ok := adminAssistantConversationId(c)
	if !ok {
		return
	}
	userId := c.GetInt("id")
	conversation, err := model.GetAdminAssistantConversation(userId, id)
	if err != nil || conversation.Kind != model.AdminAssistantConversationKindQQ {
		common.ApiErrorMsg(c, "QQ 会话不存在")
		return
	}
	var req struct {
		Message string `json:"message"`
	}
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		common.ApiError(c, err)
		return
	}
	req.Message = strings.TrimSpace(req.Message)
	if req.Message == "" {
		common.ApiErrorMsg(c, "请输入要发送的消息")
		return
	}
	target := strings.TrimSpace(strings.TrimPrefix(conversation.Title, "QQ "))
	if target == "" || target == conversation.Title {
		common.ApiErrorMsg(c, "QQ 会话缺少目标 ID")
		return
	}
	if err := securitydefensesvc.SendQQReply(target, req.Message); err != nil {
		common.ApiErrorMsg(c, err.Error())
		return
	}
	message := &model.AdminAssistantMessage{
		ConversationId: id,
		UserId:         userId,
		Role:           "assistant",
		Content:        maskAdminAssistantStoredText("管理员发送：" + req.Message),
		Metadata:       `{"source":"admin","direction":"outbound"}`,
	}
	if err := model.AppendAdminAssistantMessage(message); err != nil {
		common.ApiError(c, err)
		return
	}
	recordManageAudit(c, "admin_assistant.qq.send", map[string]interface{}{"conversation_id": id})
	common.ApiSuccess(c, message)
}

func GetAdminAssistantConversationMessages(c *gin.Context) {
	id, ok := adminAssistantConversationId(c)
	if !ok {
		return
	}
	if id == twinVirtualConversationID {
		// 本机分身：代理读取本机 history（读本机为准，不在 HK 侧复制）。
		msgs := fetchTwinHistory(c.Request.Context())
		if msgs == nil {
			msgs = []model.AdminAssistantMessage{}
		}
		common.ApiSuccess(c, msgs)
		return
	}
	messages, err := model.ListAdminAssistantMessages(c.GetInt("id"), id, 100)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			common.ApiErrorMsg(c, "对话不存在")
			return
		}
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, messages)
}

func SendAdminAssistantConversationMessage(c *gin.Context) {
	id, ok := adminAssistantConversationId(c)
	if !ok {
		return
	}
	userId := c.GetInt("id")
	var req struct {
		Message string `json:"message"`
		Apply   bool   `json:"apply"`
		Backend string `json:"backend"`
	}
	if err := common.DecodeJson(c.Request.Body, &req); err != nil {
		common.ApiError(c, err)
		return
	}
	req.Message = strings.TrimSpace(req.Message)
	if req.Message == "" {
		common.ApiErrorMsg(c, "请输入消息")
		return
	}
	if id == twinVirtualConversationID {
		// 本机分身虚拟会话（不在 HK DB）：直接走分身对话，读本机为准。
		virtualConv := twinVirtualConversation(userId, fetchTwinHistory(c.Request.Context()))
		handleTwinAssistantMessage(c, virtualConv, userId, req.Message)
		return
	}
	conversation, errConv := model.GetAdminAssistantConversation(userId, id)
	if errConv != nil {
		common.ApiErrorMsg(c, "对话不存在")
		return
	}
	// 后端选择：请求显式指定优先（hermes/twin），否则按会话 kind；twin = 本机分身（虚无圣灵）
	backend := strings.TrimSpace(req.Backend)
	if backend == "" {
		backend = strings.TrimSpace(conversation.Kind)
	}
	if backend == model.AdminAssistantConversationKindTwin {
		handleTwinAssistantMessage(c, conversation, userId, req.Message)
		return
	}

	existing, err := model.ListAdminAssistantMessages(userId, id, 24)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	history := make([]adminassistantsvc.ChatMessage, 0, len(existing))
	for _, message := range existing {
		history = append(history, adminassistantsvc.ChatMessage{Role: message.Role, Content: message.Content})
	}
	report := adminassistantsvc.BuildCommandReportWithHistory(
		c.Request.Context(),
		securityDefenseBaseURL(c),
		req.Message,
		adminAssistantModelContext(map[string]interface{}{"conversation_id": id, "apply_requested": req.Apply}),
		history,
	)
	proposed := parseAdminAssistantProposedActions(report.AIOutput)
	var applied []gin.H
	var applyErr error
	if req.Apply && len(proposed) > 0 {
		applied, applyErr = applyAdminAssistantActions(c, proposed)
	}

	userMessage := &model.AdminAssistantMessage{
		ConversationId: id,
		UserId:         userId,
		Role:           "user",
		Content:        maskAdminAssistantStoredText(req.Message),
	}
	if err := model.AppendAdminAssistantMessage(userMessage); err != nil {
		common.ApiError(c, err)
		return
	}
	assistantText := strings.TrimSpace(report.AIOutput)
	if assistantText == "" {
		assistantText = report.AIError
	}
	if assistantText == "" {
		assistantText = report.LocalPlan
	}
	metadata, _ := common.Marshal(gin.H{
		"model":          report.Model,
		"proposed_count": len(proposed),
		"applied":        sanitizeAdminAssistantAuditResults(applied),
		"apply_error":    maskedError(applyErr),
	})
	assistantMessage := &model.AdminAssistantMessage{
		ConversationId: id,
		UserId:         userId,
		Role:           "assistant",
		Content:        maskAdminAssistantStoredText(assistantText),
		Metadata:       string(metadata),
	}
	if err := model.AppendAdminAssistantMessage(assistantMessage); err != nil {
		common.ApiError(c, err)
		return
	}
	result := gin.H{
		"conversation":      conversation,
		"user_message":      userMessage,
		"assistant_message": assistantMessage,
		"report":            report,
		"proposed_actions":  proposed,
		"applied":           applied,
	}
	if applyErr != nil {
		c.JSON(200, gin.H{"success": false, "message": applyErr.Error(), "data": result})
		return
	}
	recordManageAudit(c, "admin_assistant.conversation.message", map[string]interface{}{
		"conversation_id": id,
		"applied_count":   len(applied),
		"model":           report.Model,
	})
	common.ApiSuccess(c, result)
}

func adminAssistantConversationId(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || (id != twinVirtualConversationID && id <= 0) {
		common.ApiErrorMsg(c, "对话 ID 无效")
		return 0, false
	}
	return id, true
}

func maskAdminAssistantStoredText(value string) string {
	value = common.MaskSensitiveInfo(strings.TrimSpace(value))
	return assistantStoredSecretPattern.ReplaceAllString(value, "$1***")
}

func sanitizeAdminAssistantAuditResults(results []gin.H) []gin.H {
	if len(results) == 0 {
		return nil
	}
	sanitized := make([]gin.H, 0, len(results))
	for _, result := range results {
		sanitized = append(sanitized, sanitizeAdminAssistantAuditResult(result))
	}
	return sanitized
}

func maskedError(err error) string {
	if err == nil {
		return ""
	}
	return common.MaskSensitiveInfo(err.Error())
}

// handleTwinAssistantMessage 本机分身（虚无圣灵）对话：直接把用户原始消息转发到本机
// /api/cluster/chat（不套 Hermes 管理命令上下文），回复落盘到本机 twin history（twin-daemon 自写），
// HK 侧不复制（代理读取，读本机为准）。返回的 user/assistant 为内存结构，仅供 APP 即时渲染。
func handleTwinAssistantMessage(c *gin.Context, conversation *model.AdminAssistantConversation, userId int, message string) {
	id := conversation.Id
	twinCfg := assistantsetting.TwinSnapshot()
	if !twinCfg.Enabled {
		common.ApiErrorMsg(c, "本机分身后端未启用（后台设置 AssistantTwinEnabled）")
		return
	}
	userMessage := &model.AdminAssistantMessage{
		ConversationId: id,
		UserId:         userId,
		Role:           "user",
		Content:        maskAdminAssistantStoredText(message),
	}
	reply, twinErr := adminassistantsvc.BuildTwinReply(c.Request.Context(), twinCfg.Endpoint, twinCfg.Token, message)
	assistantText := reply
	if twinErr != nil {
		assistantText = "本机分身对话失败：" + twinErr.Error()
	}
	assistantMessage := &model.AdminAssistantMessage{
		ConversationId: id,
		UserId:         userId,
		Role:           "assistant",
		Content:        maskAdminAssistantStoredText(assistantText),
	}
	result := gin.H{
		"conversation":      conversation,
		"user_message":      userMessage,
		"assistant_message": assistantMessage,
		"backend":           "twin",
	}
	if twinErr != nil {
		c.JSON(200, gin.H{"success": false, "message": "本机分身对话失败: " + twinErr.Error(), "data": result})
		return
	}
	recordManageAudit(c, "admin_assistant.conversation.message", map[string]interface{}{
		"conversation_id": id,
		"backend":         "twin",
	})
	common.ApiSuccess(c, result)
}
