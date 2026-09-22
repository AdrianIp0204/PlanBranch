"""Deterministic native Ollama HTTP fixture, not shipped in the application."""
import argparse
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import threading
from uuid import uuid4

from flowdesk.app import create_app
from flowdesk import codex_planner
from flowdesk.providers import ProviderRegistry
from waitress import serve

MODEL = 'fixture-local:small'

class OllamaFixture(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def reply(self, value):
        encoded=json.dumps(value).encode()
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(encoded)))
        self.end_headers();self.wfile.write(encoded)
    def do_GET(self):
        if self.path == '/api/version': return self.reply({'version':'0.21.0'})
        if self.path == '/api/tags': return self.reply({'models':[{'name':MODEL,'digest':'a'*64},{'name':'embedding-only:latest','digest':'b'*64}]})
        self.send_error(404)
    def do_POST(self):
        packet=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path == '/api/show':
            return self.reply({'capabilities':['embedding'] if packet['model'].startswith('embedding-') else ['completion','tools','thinking'],
                               'details':{'family':'fixture'},'model_info':{'general.architecture':'fixture','fixture.context_length':32768}})
        if self.path != '/api/chat': return self.send_error(404)
        context=json.loads(packet['messages'][-1]['content'].split('\n',1)[1])
        prompt=context['messages'][-1]['text']
        envelope={'protocolVersion':4,'kind':'reply','message':'Local fixture reply.','questions':[],'proposal':None}
        if 'question' in prompt.lower() and not prompt.startswith('Answers to planning questions:'):
            envelope.update(kind='questions',message='Choose a storage format.',questions=[{'id':'storage','kind':'choice','prompt':'Where should tasks be saved?',
                'options':[{'id':'json','label':'JSON','description':'A local file.'},{'id':'sqlite','label':'SQLite','description':'A local database.'}], 'recommendedOptionId':'sqlite'}])
        elif 'proposal' in prompt.lower():
            diagram=next(d for d in context['content']['diagrams'] if d['id']==context['activeDiagramId'])
            nodes=deepcopy(diagram['nodes'])
            nodes.append({'id':str(uuid4()),'type':'process','title':'Ollama proposed step','position':{'x':500,'y':400},'status':'not_started','checklist':[],
                **{key:'' for key in ('description','notes','pseudocode','targetFile','targetScope','why','alternatives','blocker')}})
            envelope.update(kind='proposal',message='Review the proposed local step.',proposal={'title':'Local proposal','summary':'Add one reviewed step.',
                'diagramId':diagram['id'],'nodes':nodes,'edges':diagram['edges'],'brief':None,'buildTasks':None})
        response={'model':MODEL,'message':{'role':'assistant','content':json.dumps(envelope)},'done':True,'done_reason':'stop','prompt_eval_count':100,'eval_count':80}
        if packet.get('stream'):
            data=(json.dumps(response)+'\n').encode();self.send_response(200);self.send_header('Content-Type','application/x-ndjson');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        else: self.reply(response)

if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,required=True);parser.add_argument('--data-dir',required=True);args=parser.parse_args()
    native=ThreadingHTTPServer(('127.0.0.1',0),OllamaFixture)
    os.environ['PLANBRANCH_OLLAMA_URL']=f'http://127.0.0.1:{native.server_port}'
    for key in ('OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY'): os.environ.pop(key,None)
    codex_planner._executable=lambda: None
    threading.Thread(target=native.serve_forever,daemon=True).start()
    app=create_app(args.data_dir,planner=ProviderRegistry(args.data_dir))
    serve(app,host='127.0.0.1',port=args.port)
