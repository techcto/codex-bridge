import { URL } from 'node:url';
import {
  getLocalToolDefinitions,
  getOpenAIChatCompletionsLocalTools,
  getOpenAIResponsesLocalTools,
  OPENAI_HOSTED_TOOL_TYPES,
  validateLocalToolDefinitionNames,
} from './local-tools.mjs';

export function createBridgeRequestHandler(deps) {
  return async function handleBridgeRequest(request, response) {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    const authState = deps.getRuntimeAuthState();
    deps.logBridge(`request ${request.method || 'GET'} ${url.pathname}${url.search}`);

    if (request.method === 'OPTIONS') {
      response.writeHead(204, deps.buildCorsHeaders(request));
      response.end();
      return;
    }

    if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
      return deps.proxyOpenAiCompatibleRequest(request, response, url);
    }

    if (url.pathname === '/health') {
      const loginStatus = await deps.authService.getLoginStatusForHealth();
      return deps.sendJson(request, response, {
        ok: true,
        service: 'codex-bridge',
        auth_state: authState,
        has_api_key: deps.runtimeHasDirectApiKey(),
        ...deps.getRuntimeInfo(),
        login_status: loginStatus,
      });
    }

    if (url.pathname === '/runtime/config' && request.method === 'GET') {
      return deps.sendJson(request, response, {
        ok: true,
        service: 'codex-bridge',
        config: deps.summarizeRuntimeConfig(),
      });
    }

    if (url.pathname === '/runtime/config' && request.method === 'POST') {
      try {
        const payload = await deps.readJsonBody(request);
        const result = await deps.applyRuntimeConfig(payload, { restart: true });
        return deps.sendJson(request, response, {
          ok: true,
          service: 'codex-bridge',
          ...result,
        });
      } catch (error) {
        return deps.sendJson(request, response, {
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to update runtime config',
        }, 400);
      }
    }

    if (url.pathname === '/runtime/info') {
      return deps.sendJson(request, response, {
        ok: true,
        service: 'codex-bridge',
        ...deps.getRuntimeInfo(),
      });
    }

    if (url.pathname === '/runtime/tools' && request.method === 'GET') {
      const format = String(url.searchParams.get('format') || 'responses').trim().toLowerCase();
      const toolNameErrors = validateLocalToolDefinitionNames();
      const localTools = getLocalToolDefinitions();
      const tools = format === 'local'
        ? localTools
        : (format === 'chat' || format === 'chat_completions' || format === 'chat-completions')
          ? getOpenAIChatCompletionsLocalTools()
          : getOpenAIResponsesLocalTools();

      return deps.sendJson(request, response, {
        ok: toolNameErrors.length === 0,
        service: 'codex-bridge',
        format,
        local_tool_count: localTools.length,
        hosted_openai_tool_types: OPENAI_HOSTED_TOOL_TYPES,
        tool_name_errors: toolNameErrors,
        tools,
      }, toolNameErrors.length ? 500 : 200);
    }

    if (url.pathname === '/chat/sessions' && request.method === 'POST') {
      try {
        const payload = await deps.readJsonBody(request);
        const session = deps.chatSessionService.createSession(payload);
        return deps.sendJson(request, response, {
          ok: true,
          session: deps.chatSessionService.serializeSession(session),
        }, 201);
      } catch (error) {
        return deps.sendJson(request, response, {
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to create chat session',
        }, 400);
      }
    }

    const sessionMatch = url.pathname.match(/^\/chat\/sessions\/([a-f0-9-]+)$/i);
    if (sessionMatch && request.method === 'GET') {
      const session = deps.chatSessionService.getSession(sessionMatch[1]);
      if (!session) {
        return deps.sendJson(request, response, { ok: false, error: 'Session not found' }, 404);
      }

      return deps.sendJson(request, response, {
        ok: true,
        session: deps.chatSessionService.serializeSession(session),
      });
    }

    const streamMatch = url.pathname.match(/^\/chat\/sessions\/([a-f0-9-]+)\/stream$/i);
    if (streamMatch && request.method === 'GET') {
      const session = deps.chatSessionService.getSession(streamMatch[1]);
      if (!session) {
        return deps.sendJson(request, response, { ok: false, error: 'Session not found' }, 404);
      }

      deps.sendSseHeaders(request, response);
      session.subscribers.add(response);
      deps.writeSse(response, 'session.ready', { session: deps.chatSessionService.serializeSession(session) });

      const keepAlive = setInterval(() => {
        try {
          response.write(': keepalive\n\n');
        } catch (_error) {}
      }, 15000);

      request.on('close', () => {
        clearInterval(keepAlive);
        session.subscribers.delete(response);
        try {
          response.end();
        } catch (_error) {}
      });

      return;
    }

    const messageMatch = url.pathname.match(/^\/chat\/sessions\/([a-f0-9-]+)\/messages$/i);
    if (messageMatch && request.method === 'POST') {
      const session = deps.chatSessionService.getSession(messageMatch[1]);
      if (!session) {
        return deps.sendJson(request, response, { ok: false, error: 'Session not found' }, 404);
      }

      try {
        const payload = await deps.readJsonBody(request);
        const message = String(payload.message || '').trim();
        const attachments = deps.sanitizeAttachments(payload.attachments);
        if (message === '' && attachments.length === 0) {
          return deps.sendJson(request, response, { ok: false, error: 'Message or attachment is required' }, 400);
        }

        if (payload.context && typeof payload.context === 'object') {
          session.context = payload.context;
        }

        session.pendingAttachments = attachments;
        const scheduled = deps.chatSessionService.scheduleChatTurn(session, message);

        return deps.sendJson(request, response, {
          ok: true,
          queued: scheduled.queued,
          bridge_load: scheduled.load,
          session: deps.chatSessionService.serializeSession(session),
        }, 202);
      } catch (error) {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
        return deps.sendJson(request, response, {
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to send message',
          bridge_load: deps.chatSessionService.getBridgeLoad(),
        }, statusCode);
      }
    }

    const cancelMatch = url.pathname.match(/^\/chat\/sessions\/([a-f0-9-]+)\/cancel$/i);
    if (cancelMatch && request.method === 'POST') {
      const session = deps.chatSessionService.cancelSession(cancelMatch[1]);
      if (!session) {
        return deps.sendJson(request, response, { ok: false, error: 'Session not found' }, 404);
      }

      return deps.sendJson(request, response, {
        ok: true,
        session: deps.chatSessionService.serializeSession(session),
      }, 202);
    }

    const approvalMatch = url.pathname.match(/^\/chat\/sessions\/([a-f0-9-]+)\/approvals$/i);
    if (approvalMatch && request.method === 'POST') {
      const session = deps.chatSessionService.getSession(approvalMatch[1]);
      if (!session) {
        return deps.sendJson(request, response, { ok: false, error: 'Session not found' }, 404);
      }

      try {
        const payload = await deps.readJsonBody(request);
        const decision = String(payload.decision || '').trim().toLowerCase();
        const updatedSession = await deps.chatSessionService.respondToPendingApproval(session.id, decision);
        return deps.sendJson(request, response, {
          ok: true,
          session: deps.chatSessionService.serializeSession(updatedSession),
        }, 202);
      } catch (error) {
        return deps.sendJson(request, response, {
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to respond to approval request',
        }, 400);
      }
    }

    if (url.pathname === '/chat/sessions' && request.method === 'DELETE') {
      deps.chatSessionService.clearSessions();
      return deps.sendEmpty(response);
    }

    if (url.pathname === '/cms/thinking' && request.method === 'GET') {
      const parentOrigin = String(url.searchParams.get('parent_origin') || '').trim();
      return deps.sendHtml(
        request,
        response,
        deps.renderCmsThinkingPage(),
        200,
        { allowFrame: true, parentOrigin }
      );
    }

    if (url.pathname === '/cms/generate/add-page' && request.method === 'POST') {
      try {
        const payload = await deps.readJsonBody(request);
        const prompt = String(payload.prompt || '').trim();
        const generated = await deps.chatSessionService.generateCmsPageHtml({
          prompt,
          context: payload.context && typeof payload.context === 'object' ? payload.context : {},
          instruction: 'Create a Bootstrap 5 landing page HTML for this CMS page request. Return only final HTML with no markdown fences and no extra commentary.',
        });
        return deps.sendJson(request, response, {
          ok: true,
          session_id: generated.session_id,
          html: generated.html,
        });
      } catch (error) {
        return deps.sendJson(request, response, {
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to generate page HTML',
        }, 400);
      }
    }

    if (url.pathname === '/cms/generate/add-website' && request.method === 'POST') {
      try {
        const payload = await deps.readJsonBody(request);
        const prompt = String(payload.prompt || '').trim();
        const websiteKind = String(payload.website_kind || 'business').trim().toLowerCase();
        const pageInstruction = websiteKind === 'landing'
          ? 'Create a Bootstrap 5 homepage HTML for a landing website request. Include sections optimized for conversion and leave room for an embedded lead form module. Return only final HTML.'
          : 'Create a Bootstrap 5 homepage HTML for this website request. Return only final HTML with no markdown fences and no extra commentary.';
        const pageResult = await deps.chatSessionService.generateCmsPageHtml({
          prompt,
          context: payload.context && typeof payload.context === 'object' ? payload.context : {},
          instruction: pageInstruction,
        });

        let formHtml = '';
        if (websiteKind === 'landing') {
          const formResult = await deps.chatSessionService.generateCmsPageHtml({
            prompt,
            context: payload.context && typeof payload.context === 'object' ? payload.context : {},
            instruction: 'Create only a compact Bootstrap 5 lead form section HTML for this website request. Return only final HTML.',
          });
          formHtml = formResult.html;
        }

        return deps.sendJson(request, response, {
          ok: true,
          session_id: pageResult.session_id,
          page_html: pageResult.html,
          form_html: formHtml,
        });
      } catch (error) {
        return deps.sendJson(request, response, {
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to generate website HTML',
        }, 400);
      }
    }

    if (url.pathname === '/cms/generate/add-module' && request.method === 'POST') {
      try {
        const payload = await deps.readJsonBody(request);
        const prompt = String(payload.prompt || '').trim();
        const moduleKind = String(payload.module_kind || 'blog').trim().toLowerCase();
        const schemaFields = Array.isArray(payload.schema_fields)
          ? payload.schema_fields
              .filter((field) => field && typeof field === 'object' && String(field.name || '').trim() !== '')
              .map((field) => ({
                name: String(field.name || '').trim(),
                type: String(field.type || '').trim(),
                length: String(field.length || '').trim(),
                allow_null: Boolean(field.allow_null),
                default_value: String(field.default_value || '').trim(),
              }))
          : [];
        const schemaHint = schemaFields.length
          ? `\n\nSchema fields to use exactly (name/type/length/null/default):\n${JSON.stringify(schemaFields, null, 2)}\n\nBuild Bootstrap form-template HTML that includes form controls matching these field names exactly.`
          : '';
        const moduleInstruction = moduleKind === 'calendar'
          ? 'Create a Bootstrap form-template HTML for a calendar/events module. Include practical fields such as event title, summary, start/end date, location, organizer, and status. Return only final HTML for form fields (no markdown fences).'
          : moduleKind === 'alerts'
            ? 'Create a Bootstrap form-template HTML for an alerts module. Include practical fields such as alert title, message, severity, start/end date, call-to-action label/url, and active status. Return only final HTML for form fields.'
            : 'Create a Bootstrap form-template HTML for a blog/content module. Include practical fields such as title, slug, summary, hero image, body content, publish date, author, tags, and status. Return only final HTML for form fields.';
        const moduleResult = await deps.chatSessionService.generateCmsPageHtml({
          prompt,
          context: payload.context && typeof payload.context === 'object' ? payload.context : {},
          instruction: `${moduleInstruction}${schemaHint}`,
        });
        return deps.sendJson(request, response, {
          ok: true,
          session_id: moduleResult.session_id,
          form_html: moduleResult.html,
        });
      } catch (error) {
        return deps.sendJson(request, response, {
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to generate module form template',
        }, 400);
      }
    }

    if (url.pathname === '/cms/generate/add-form' && request.method === 'POST') {
      try {
        const payload = await deps.readJsonBody(request);
        const prompt = String(payload.prompt || '').trim();
        const formKind = String(payload.form_kind || 'contact').trim().toLowerCase();
        const formInstruction = formKind === 'signup'
          ? 'Create a Bootstrap form-template HTML for a signup form. Include first/last name, email, company (optional), marketing opt-in checkbox, and submit button. Return only final HTML form fields.'
          : 'Create a Bootstrap form-template HTML for a contact form. Include name, email, phone (optional), subject, message, consent checkbox, and submit button. Return only final HTML form fields.';
        const formResult = await deps.chatSessionService.generateCmsPageHtml({
          prompt,
          context: payload.context && typeof payload.context === 'object' ? payload.context : {},
          instruction: formInstruction,
        });
        return deps.sendJson(request, response, {
          ok: true,
          session_id: formResult.session_id,
          form_html: formResult.html,
        });
      } catch (error) {
        return deps.sendJson(request, response, {
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to generate form template',
        }, 400);
      }
    }

    if (url.pathname === '/auth/device') {
      if (!deps.runtimeRequiresLogin()) {
        return deps.sendJson(request, response, {
          ok: true,
          auth_mode: deps.getRuntimeAuthState(),
          message: 'This runtime provider does not require device authentication.',
        });
      }

      try {
        const payload = await deps.authService.ensureDeviceAuth();
        return deps.sendJson(request, response, {
          ok: true,
          auth_mode: 'chatgpt',
          ...payload,
        });
      } catch (error) {
        return deps.sendJson(request, response, {
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to start device auth',
        }, 500);
      }
    }

    if (url.pathname === '/auth/status') {
      const loginStatus = await deps.authService.getLoginStatusWithFinalize();
      return deps.sendJson(request, response, {
        ok: true,
        ...loginStatus,
      });
    }

    if (url.pathname !== '/') {
      return deps.sendJson(request, response, { ok: false, error: 'Not Found' }, 404);
    }

    const contextName = url.searchParams.get('context_name') || '';
    const contextType = url.searchParams.get('context_type') || 'document';
    const contextId = url.searchParams.get('context_id') || '';
    const loginHint = deps.runtimeRequiresLogin()
      ? deps.defaultLoginHint
      : 'This runtime provider is configured for direct API or local model access, so no interactive login is required.';

    return deps.sendHtml(request, response, deps.renderPage({
      contextName,
      contextType,
      contextId,
      loginHint,
      authState,
    }));
  };
}
