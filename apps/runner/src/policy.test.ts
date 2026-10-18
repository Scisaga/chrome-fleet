import test from 'node:test';
import assert from 'node:assert/strict';
import { Image, normalizeProxy, ProfileId, profilePath, StartBody } from './policy.js';
const id='cf_550e8400-e29b-41d4-a716-446655440000';
test('Runner refuses arbitrary image, profile and host options',()=>{
  assert.equal(ProfileId.safeParse(id).success,true);
  for(const value of ['../../etc','nginx','cf_fake','550e8400-e29b-41d4-a716-446655440000'])assert.equal(ProfileId.safeParse(value).success,false);
  assert.equal(Image.safeParse('ubuntu:latest').success,false);
  assert.equal(Image.safeParse('chrome-fleet/browser:google-155.0.8059.79').success,true);
  assert.equal(StartBody.safeParse({image:'chrome-fleet/browser:google-stable',config:{},privileged:true}).success,false);
  assert.equal(profilePath('/var/lib/chrome-fleet',id,'state'),`/var/lib/chrome-fleet/profiles/${id}/state`);
});
test('authenticated SOCKS5 is explicitly unsupported and secrets are never URL embedded',()=>{
  const defaults=StartBody.parse({image:'chrome-fleet/browser:google-stable',config:{}}).config;
  assert.equal(defaults.browserMode,'automation');
  assert.equal(StartBody.parse({image:'chrome-fleet/browser:google-stable',config:{browserMode:'vnc'}}).config.browserMode,'vnc');
  assert.equal(StartBody.safeParse({image:'chrome-fleet/browser:google-stable',config:{browserMode:'arbitrary'}}).success,false);
  assert.throws(()=>normalizeProxy({...defaults,proxy:{server:'socks5://proxy.example:1080',username:'fixture'}}));
  assert.throws(()=>normalizeProxy({...defaults,proxy:{server:'http://user:password@proxy.example'}}));
  assert.doesNotThrow(()=>normalizeProxy({...defaults,proxy:{server:'http://proxy.example:3128',username:'fixture',password:'fixture'}}));
});
