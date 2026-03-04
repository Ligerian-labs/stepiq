# Builder - AI-Powered Pipeline Creation

The Builder is an AI-powered chat interface that allows users to create, modify, and run automation pipelines through natural language conversation.

## Features

### 🎯 Core Capabilities

- **Natural Language Pipeline Creation**: Describe what you want in plain English
- **Multi-Turn Editing**: Iteratively refine your pipeline through conversation
- **Live Preview**: See your pipeline being built in real-time
- **Template System**: Start from pre-built templates for common use cases
- **Direct Execution**: Run pipelines directly from the chat interface
- **Session Persistence**: Save and resume conversations later

### 🤖 Supported Models

- GPT-5.2, GPT-4o, GPT-4o-mini (OpenAI)
- Claude Opus 4.6, Claude Sonnet 4, Claude Haiku 3.5 (Anthropic)
- Gemini 2.5 Pro, Gemini 2.5 Flash (Google)
- GLM-5, GLM-4.6 (Z.ai)
- Mistral Large, Mistral Small

## Getting Started

### 1. Run Migrations

```bash
cd apps/api
bunx drizzle-kit migrate
```

### 2. Seed Templates

```bash
cd apps/api
pnpm run seed:templates
```

### 3. Configure API Keys

Set environment variables for model access:

```bash
# .env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

### 4. Start the Application

```bash
bun run dev
```

### 5. Access Builder

Navigate to `/builder` in your application.

## Usage

### Creating a New Pipeline

1. Click "+ New Chat" to start a new session
2. Select your preferred model
3. Describe your pipeline in natural language:
   ```
   "Create a web scraper that fetches product prices from Amazon 
   and extracts the title, price, and image URL"
   ```
4. The AI will generate a pipeline definition
5. Review the pipeline in the preview panel
6. Click "Apply to Editor" to save and edit

### Editing an Existing Pipeline

1. Load an existing session or pipeline
2. Request modifications:
   ```
   "Add a step to send the results via email"
   "Change step 2 to use Claude instead of GPT"
   "Remove the validation step"
   ```
3. The AI will update the pipeline accordingly
4. Apply changes when satisfied

### Running a Pipeline

1. Build or load a pipeline
2. Click "Run Pipeline"
3. Provide required inputs if prompted
4. View execution results in real-time

### Using Templates

1. Start a new chat session
2. Browse available templates:
   - Web Scraper
   - Content Generator
   - API Integration
   - Data Processor
   - Monitor & Alert
3. Select a template to start from
4. Customize as needed

## Architecture

### Backend

**Database Tables:**
- `chat_sessions` - Session metadata and state
- `chat_messages` - Conversation history with pipeline snapshots
- `pipeline_templates` - Reusable pipeline templates

**API Endpoints:**
- `POST /api/chat/sessions` - Create session
- `GET /api/chat/sessions` - List sessions
- `GET /api/chat/sessions/:id` - Get session with messages
- `DELETE /api/chat/sessions/:id` - Archive session
- `POST /api/chat/sessions/:id/messages` - Send message
- `POST /api/chat/sessions/:id/apply` - Apply to editor
- `POST /api/chat/sessions/:id/run` - Run pipeline
- `GET /api/chat/templates` - List templates
- `POST /api/chat/sessions/:id/from-template` - Use template

**Services:**
- `chat.ts` - Conversation management and model integration
- Multi-turn state tracking
- Pipeline version control
- Model routing (OpenAI, Anthropic, etc.)

### Frontend

**Components:**
- `BuilderPage` - Main chat interface
- `ChatMessage` - Message display
- `ChatInput` - User input
- `ModelSelector` - Model selection
- `PipelinePreview` - Live pipeline visualization

**Features:**
- Split-view layout (chat + preview)
- Real-time updates
- Keyboard shortcuts (⌘+Enter to send)
- Session management
- Model selection

## Pipeline Definition Format

Pipelines are defined in JSON with the following structure:

```json
{
  "name": "Pipeline Name",
  "version": 1,
  "steps": [
    {
      "id": "step_1",
      "name": "Step Name",
      "type": "llm",
      "model": "gpt-5.2",
      "prompt": "Your prompt here",
      "output_format": "text"
    }
  ],
  "variables": {
    "key": "value"
  },
  "output": {
    "from": "step_1"
  }
}
```

## Best Practices

### Writing Good Prompts

1. **Be Specific**: Clearly describe what you want
   - ✅ "Create a pipeline that scrapes product data from Amazon and saves it to a database"
   - ❌ "Make a scraper"

2. **Provide Context**: Include relevant details
   - "The pipeline should handle pagination and rate limiting"
   - "Use Claude for analysis steps and GPT for generation"

3. **Iterate**: Refine through conversation
   - "Add error handling to step 2"
   - "Make step 3 run in parallel with step 2"

4. **Review**: Always check the generated pipeline
   - Verify step order
   - Check model selection
   - Validate prompts

### Model Selection

- **GPT-5.2**: Best for complex reasoning and generation
- **Claude Opus**: Excellent for analysis and understanding
- **Claude Sonnet**: Good balance of speed and quality
- **GPT-4o-mini**: Fast and cost-effective for simple tasks
- **Gemini Flash**: Quick responses for straightforward operations

## Troubleshooting

### Model Not Responding

1. Check API keys are configured
2. Verify model availability in your region
3. Check API quotas and limits

### Pipeline Validation Errors

1. Review the generated JSON
2. Check for missing required fields
3. Verify step IDs are unique
4. Ensure output references are valid

### Session Not Saving

1. Check database connection
2. Verify migrations have run
3. Check for console errors

## Future Enhancements

- [ ] Streaming responses for real-time feedback
- [ ] Voice input support
- [ ] Pipeline visualization graph
- [ ] Collaborative editing
- [ ] Custom template creation
- [ ] Pipeline version history
- [ ] Export/import chat sessions
- [ ] Advanced analytics

## Contributing

To add new features or fix bugs:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `pnpm test`
5. Submit a pull request

## License

MIT
