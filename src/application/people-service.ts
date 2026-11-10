import type { SearchIndex } from '../ports/index.js';
import type { EntityPatch, SearchQuery } from '../domain/types.js';
import { MemoryService } from './memory-service.js';

export class PeopleService {
  constructor(private readonly memory:MemoryService,private readonly index:SearchIndex){}
  create(title:string,content='',metadata:Record<string,unknown>={},client?:string){return this.memory.createWithDedup({type:'person',title,content,metadata},client);}
  update(id:string,patch:EntityPatch,revision:string,client?:string){return this.memory.update(id,patch,revision,client);}
  get(id:string){return this.memory.get(id);}
  search(query:SearchQuery={}){return this.memory.search({...query,types:['person']});}
  birthdays(from:string,to:string){return this.index.dateWindow('birth_date',from,to);}
  nameDays(from:string,to:string){return this.index.dateWindow('name_day',from,to);}
  async context(id:string){return {person:await this.get(id),related:await this.memory.related(id)};}
}
