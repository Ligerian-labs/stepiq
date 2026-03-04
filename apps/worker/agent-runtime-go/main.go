package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"syscall/js"
	"time"

	anyllm "github.com/mozilla-ai/any-llm-go"
	"github.com/mozilla-ai/any-llm-go/providers/anthropic"
	"github.com/mozilla-ai/any-llm-go/providers/gemini"
	"github.com/mozilla-ai/any-llm-go/providers/mistral"
	"github.com/mozilla-ai/any-llm-go/providers/openai"
)

type AgentTool struct {
	Type        string         `json:"type"`
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	InputSchema map[string]any `json:"input_schema,omitempty"`
	JSSource    string         `json:"js_source,omitempty"`
}

type AgentConfig struct {
	MaxTurns           int         `json:"max_turns"`
	MaxDurationSeconds int         `json:"max_duration_seconds"`
	MaxToolCalls       int         `json:"max_tool_calls"`
	Tools              []AgentTool `json:"tools"`
	NetworkAllowlist   []string    `json:"network_allowlist"`
}

type AgentInput struct {
	Provider     string            `json:"provider"`
	Model        string            `json:"model"`
	Prompt       string            `json:"prompt"`
	System       string            `json:"system,omitempty"`
	Temperature  *float64          `json:"temperature,omitempty"`
	MaxTokens    *int              `json:"max_tokens,omitempty"`
	OutputFormat string            `json:"output_format,omitempty"`
	APIKeys      map[string]string `json:"api_keys,omitempty"`
	Agent        AgentConfig       `json:"agent"`
}

type ToolCallRecord struct {
	ToolName string `json:"tool_name"`
	Args     string `json:"args"`
	Result   string `json:"result"`
	Error    string `json:"error,omitempty"`
}

type AgentTurnTrace struct {
	Turn         int              `json:"turn"`
	Assistant    string           `json:"assistant"`
	FinishReason string           `json:"finish_reason,omitempty"`
	ToolCalls    []ToolCallRecord `json:"tool_calls,omitempty"`
}

type AgentOutput struct {
	Output           string           `json:"output"`
	InputTokens      int              `json:"input_tokens"`
	OutputTokens     int              `json:"output_tokens"`
	TotalTokens      int              `json:"total_tokens"`
	TurnsUsed        int              `json:"turns_used"`
	ToolCallsTotal   int              `json:"tool_calls_total"`
	ToolCallsSuccess int              `json:"tool_calls_success"`
	ToolCallsFailed  int              `json:"tool_calls_failed"`
	Trace            []AgentTurnTrace `json:"trace"`
}

type RuntimeLogEntry struct {
	Ts      string         `json:"ts"`
	Level   string         `json:"level"`
	Source  string         `json:"source"`
	Event   string         `json:"event"`
	Message string         `json:"message"`
	Data    map[string]any `json:"data,omitempty"`
}

func main() {
	done := make(chan struct{}, 0)

	run := js.FuncOf(func(this js.Value, args []js.Value) any {
		promise := js.Global().Get("Promise")
		var handler js.Func
		handler = js.FuncOf(func(this js.Value, promiseArgs []js.Value) any {
			resolve := promiseArgs[0]
			reject := promiseArgs[1]

			go func() {
				defer handler.Release()

				if len(args) < 1 {
					reject.Invoke("missing input json")
					return
				}

				inputRaw := args[0].String()
				res, err := runAgentStep(inputRaw)
				if err != nil {
					reject.Invoke(err.Error())
					return
				}
				payload, err := json.Marshal(res)
				if err != nil {
					reject.Invoke(err.Error())
					return
				}
				resolve.Invoke(string(payload))
			}()

			return nil
		})
		return promise.New(handler)
	})

	js.Global().Set("stepiqRunAgentStep", run)
	<-done
}

func runAgentStep(raw string) (*AgentOutput, error) {
	var in AgentInput
	if err := json.Unmarshal([]byte(raw), &in); err != nil {
		return nil, fmt.Errorf("invalid input json: %w", err)
	}

	if strings.TrimSpace(in.Model) == "" {
		return nil, errors.New("model is required")
	}
	if in.Agent.MaxTurns <= 0 {
		in.Agent.MaxTurns = 8
	}
	if in.Agent.MaxDurationSeconds <= 0 {
		in.Agent.MaxDurationSeconds = 120
	}
	if in.Agent.MaxToolCalls < 0 {
		in.Agent.MaxToolCalls = 0
	}

	provider, err := newProvider(in)
	if err != nil {
		return nil, err
	}

	messages := make([]anyllm.Message, 0, 2)
	if strings.TrimSpace(in.System) != "" {
		messages = append(messages, anyllm.Message{Role: anyllm.RoleSystem, Content: in.System})
	}
	messages = append(messages, anyllm.Message{Role: anyllm.RoleUser, Content: in.Prompt})

	tools := toAnyLLMTools(in.Agent.Tools)
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(in.Agent.MaxDurationSeconds)*time.Second)
	defer cancel()

	out := &AgentOutput{Trace: make([]AgentTurnTrace, 0, in.Agent.MaxTurns)}
	finalOutput := ""

	for turn := 1; turn <= in.Agent.MaxTurns; turn++ {
		emitAgentLog("info", "agent_turn_started", "Agent turn started", map[string]any{
			"turn":          turn,
			"message_count": len(messages),
			"tool_count":    len(tools),
		})
		params := anyllm.CompletionParams{
			Model:       in.Model,
			Messages:    messages,
			Temperature: in.Temperature,
			MaxTokens:   in.MaxTokens,
		}
		if len(tools) > 0 {
			params.Tools = tools
			params.ToolChoice = "auto"
		}
		if in.OutputFormat == "json" {
			params.ResponseFormat = &anyllm.ResponseFormat{Type: "json_object"}
		}

		resp, err := provider.Completion(ctx, params)
		if err != nil {
			emitAgentLog("error", "agent_turn_failed", "Agent turn failed", map[string]any{
				"turn":  turn,
				"error": err.Error(),
			})
			return nil, err
		}
		if len(resp.Choices) == 0 {
			return nil, errors.New("empty choices from model")
		}

		choice := resp.Choices[0]
		assistantContent := messageContentString(choice.Message.Content)
		turnTrace := AgentTurnTrace{Turn: turn, Assistant: assistantContent, FinishReason: choice.FinishReason}
		emitAgentLog("info", "agent_turn_response_received", "Agent turn response received", map[string]any{
			"turn":            turn,
			"finish_reason":   choice.FinishReason,
			"tool_call_count": len(choice.Message.ToolCalls),
			"assistant_chars": len(assistantContent),
		})

		if resp.Usage != nil {
			out.InputTokens += resp.Usage.PromptTokens
			out.OutputTokens += resp.Usage.CompletionTokens
		}

		messages = append(messages, anyllm.Message{
			Role:      anyllm.RoleAssistant,
			Content:   assistantContent,
			ToolCalls: choice.Message.ToolCalls,
		})

		if len(choice.Message.ToolCalls) == 0 {
			finalOutput = assistantContent
			out.Trace = append(out.Trace, turnTrace)
			out.TurnsUsed = turn
			break
		}

		for _, tc := range choice.Message.ToolCalls {
			if out.ToolCallsTotal >= in.Agent.MaxToolCalls {
				result := `{"ok":false,"error":"tool call budget exceeded"}`
				messages = append(messages, anyllm.Message{
					Role:       anyllm.RoleTool,
					ToolCallID: tc.ID,
					Content:    result,
				})
				out.ToolCallsFailed++
				out.ToolCallsTotal++
				turnTrace.ToolCalls = append(turnTrace.ToolCalls, ToolCallRecord{
					ToolName: tc.Function.Name,
					Args:     tc.Function.Arguments,
					Result:   result,
					Error:    "tool call budget exceeded",
				})
				continue
			}

			toolResult, callErr := callToolHost(ctx, tc.Function.Name, tc.Function.Arguments, in.Agent.NetworkAllowlist)
			if callErr != nil {
				payload := fmt.Sprintf(`{"ok":false,"error":%q}`, callErr.Error())
			messages = append(messages, anyllm.Message{
				Role:       anyllm.RoleTool,
				ToolCallID: tc.ID,
				Content:    payload,
			})
			emitAgentLog("warn", "agent_tool_result_attached", "Tool error attached to conversation context", map[string]any{
				"turn":      turn,
				"tool_name": tc.Function.Name,
				"ok":        false,
				"error":     callErr.Error(),
			})
			out.ToolCallsFailed++
			out.ToolCallsTotal++
			turnTrace.ToolCalls = append(turnTrace.ToolCalls, ToolCallRecord{
					ToolName: tc.Function.Name,
					Args:     tc.Function.Arguments,
					Result:   payload,
					Error:    callErr.Error(),
				})
				continue
			}

			messages = append(messages, anyllm.Message{
				Role:       anyllm.RoleTool,
				ToolCallID: tc.ID,
				Content:    toolResult,
			})
			emitAgentLog("info", "agent_tool_result_attached", "Tool result attached to conversation context", map[string]any{
				"turn":         turn,
				"tool_name":    tc.Function.Name,
				"ok":           true,
				"result_chars": len(toolResult),
			})
			out.ToolCallsTotal++
			out.ToolCallsSuccess++
			turnTrace.ToolCalls = append(turnTrace.ToolCalls, ToolCallRecord{
				ToolName: tc.Function.Name,
				Args:     tc.Function.Arguments,
				Result:   toolResult,
			})
		}

		emitAgentLog("info", "agent_turn_waiting_on_model", "Agent is calling the model again with tool results", map[string]any{
			"completed_turn":     turn,
			"next_turn":          turn + 1,
			"messages_after_tool": len(messages),
		})
		out.Trace = append(out.Trace, turnTrace)
		out.TurnsUsed = turn
	}

	if strings.TrimSpace(finalOutput) == "" {
		finalOutput = ""
		if len(out.Trace) > 0 {
			finalOutput = out.Trace[len(out.Trace)-1].Assistant
		}
	}

	out.TotalTokens = out.InputTokens + out.OutputTokens
	out.Output = finalOutput
	return out, nil
}

func emitAgentLog(level, event, message string, data map[string]any) {
	logger := js.Global().Get("stepiqAgentLog")
	if logger.IsUndefined() || logger.IsNull() {
		return
	}

	entry := RuntimeLogEntry{
		Ts:      time.Now().UTC().Format(time.RFC3339Nano),
		Level:   level,
		Source:  "wasm",
		Event:   event,
		Message: message,
		Data:    data,
	}
	body, err := json.Marshal(entry)
	if err != nil {
		return
	}
	logger.Invoke(string(body))
}

func messageContentString(content any) string {
	s, ok := content.(string)
	if ok {
		return s
	}
	b, err := json.Marshal(content)
	if err != nil {
		return fmt.Sprintf("%v", content)
	}
	return string(b)
}

func toAnyLLMTools(in []AgentTool) []anyllm.Tool {
	if len(in) == 0 {
		return nil
	}
	out := make([]anyllm.Tool, 0, len(in))
	for _, tool := range in {
		params := tool.InputSchema
		if len(params) == 0 {
			params = map[string]any{
				"type":       "object",
				"properties": map[string]any{},
			}
		}
		desc := tool.Description
		if strings.TrimSpace(desc) == "" {
			desc = fmt.Sprintf("Tool %s", tool.Name)
		}
		out = append(out, anyllm.Tool{
			Type: "function",
			Function: anyllm.Function{
				Name:        tool.Name,
				Description: desc,
				Parameters:  params,
			},
		})
	}
	return out
}

func callToolHost(ctx context.Context, name, args string, allowlist []string) (string, error) {
	toolCaller := js.Global().Get("stepiqCallTool")
	if toolCaller.IsUndefined() || toolCaller.IsNull() {
		return "", errors.New("tool bridge is not available")
	}

	payload := map[string]any{
		"name":              name,
		"arguments":         args,
		"network_allowlist": allowlist,
	}
	body, _ := json.Marshal(payload)

	promise := toolCaller.Invoke(string(body))
	if promise.IsUndefined() || promise.IsNull() {
		return "", errors.New("tool bridge did not return a promise")
	}

	done := make(chan struct{})
	var once sync.Once
	var result string
	var callErr error

	then := js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) > 0 {
			result = args[0].String()
		}
		once.Do(func() { close(done) })
		return nil
	})
	catch := js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) > 0 {
			errVal := args[0]
			msg := errVal.Get("message")
			if !msg.IsUndefined() && !msg.IsNull() {
				callErr = errors.New(msg.String())
			} else {
				callErr = errors.New(errVal.String())
			}
		} else {
			callErr = errors.New("tool bridge rejected")
		}
		once.Do(func() { close(done) })
		return nil
	})

	promise.Call("then", then).Call("catch", catch)

	select {
	case <-done:
	case <-ctx.Done():
		then.Release()
		catch.Release()
		return "", fmt.Errorf("tool call %q timed out: %w", name, ctx.Err())
	}

	then.Release()
	catch.Release()

	if callErr != nil {
		return "", callErr
	}
	return result, nil
}

func newProvider(in AgentInput) (anyllm.Provider, error) {
	provider := strings.ToLower(strings.TrimSpace(in.Provider))
	apiKey := strings.TrimSpace(in.APIKeys[provider])
	opts := make([]anyllm.Option, 0, 2)
	if apiKey != "" {
		opts = append(opts, anyllm.WithAPIKey(apiKey))
	}

	switch provider {
	case "openai":
		return openai.New(opts...)
	case "anthropic":
		return anthropic.New(opts...)
	case "google", "gemini":
		return gemini.New(opts...)
	case "mistral":
		return mistral.New(opts...)
	case "zai":
		baseURL := strings.TrimSpace(in.APIKeys["zai_base_url"])
		if baseURL == "" {
			baseURL = "https://api.z.ai/api/paas/v4"
		}
		opts = append(opts, anyllm.WithBaseURL(baseURL))
		return openai.New(opts...)
	default:
		return nil, fmt.Errorf("unsupported provider %q", in.Provider)
	}
}
